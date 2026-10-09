# yo-harness 对话执行优化设计文档

> 版本 v1.0 · 2026-10-08 · 状态：待评审
> 范围：对话执行链路的准确性、效率、成本三目标优化 —— 接线已实现但未启用的能力（死代码）、并行执行、中断/超时、成本计量、Prompt Caching、token 校准等
> 覆盖层次：core（agent-loop / context-manager / compressor / planner / router / llm / tools / memory）+ cli（runtime 装配）+ server（session-manager）+ daemon（task-runner）
> 关联文档：docs/MODEL-CONFIG-DESIGN.md（模型/角色配置）、docs/APPROVAL-FLOW-DESIGN.md（审批）、docs/SESSION-WORKSPACE-DESIGN.md（会话）
> 关联代码：packages/core/src/core/agent-loop.ts · context-manager.ts · compressor.ts · summarizer.ts · planner.ts · goal-tracker.ts · checkpoint.ts · budget.ts · packages/core/src/router · packages/core/src/llm · packages/core/src/memory · packages/core/src/utils/tokens.ts · packages/cli/src/cli/runtime.tsx

---

## 目录

1. 摘要（TL;DR）
2. 背景与目标
3. 现状盘点（代码事实）
4. 目标与非目标
5. 术语
6. 总体架构与优化分层
7. Phase 1：接线（最高优先级）
8. Phase 2：结构改进
9. Phase 3：成本治理
10. Phase 4：持续优化
11. 数据模型与迁移
12. 配置项汇总
13. 实施路线图
14. 风险与回滚
15. 验收标准总表
16. 文件变更清单

---

## 1. 摘要（TL;DR）

对 yo-harness 执行链路的全量代码走查发现：架构本身是干净的（端口-适配器、事件溯源、三重熔断、Provider 契约测试），但 README 宣称的多个 Phase 2/3 能力已经实现并单测通过，却没有接入任何运行时，成为死代码。这恰恰是准确率、效率、成本三件事的最大共同杠杆——代码已就位，接线成本低、收益直接。

核心结论：

1. 死代码接线（Phase 1，最高优先级）：自适应压缩（Compressor/Summarizer）、多模型角色路由（planner/compressor/extractor）、语义记忆注入/提取、目标追踪注入、写前自动快照——五处均「已实现未接线」。
2. 效率：工具串行执行、LLM 请求无超时/无中止、中断只在 step 间生效。
3. 成本：无真实成本计量（只数 token，无价格表）、无 Prompt Caching、每步重发全量工具 schema、规划探索上下文被丢弃。
4. 准确率：stopReason === max_tokens 截断被无视、temperature 不可配、token 估算无校准反馈、裁剪方式是丢内容而非摘要。

优化按 Phase 1 → 4 分四期落地，每期独立可交付、独立可回归，采用「开关式」接入（默认值保持向后兼容，能力可逐步启用）。

---

## 2. 背景与目标

### 2.1 三个目标

| 目标 | 定义 | 衡量指标 |
|---|---|---|
| 准确性 | 长任务不漂移、跨会话复用偏好、截断可续写、上下文不丢关键信息 | 长对话任务完成率、跨会话事实一致性、截断续写成功率 |
| 效率 | 减少墙钟时间、减少无效等待 | 单 turn 墙钟时间、多工具任务耗时、中断响应延迟 |
| 成本 | 降低 token 消耗与真实花费 | 每 turn / 每会话 token 数、金额成本、缓存命中率 |

### 2.2 优化原则

1. 先接线后重构：优先把已实现、已测的能力接上，而不是新写代码。
2. 开关式接入：所有行为变更默认不破坏现有语义（向后兼容），通过配置或装配层开关启用。
3. 契约不变：core 的端口（ports.ts / types）优先扩展而非破坏；Provider 协议转换由契约测试锁定。
4. 可观测先行：成本、token 校准、缓存命中率先「能看见」，再「能优化」。

---

## 3. 现状盘点（代码事实）

以下结论均经源码 + grep 验证。

### 3.1 已实现但未接线（死代码）

| 能力 | 实现位置（已存在） | 未接线证据 |
|---|---|---|
| 自适应压缩 | compressor.ts + summarizer.ts | ContextManager.setCompressor() 仅在 context-manager.ts:111 定义，CLI/server/daemon 三个装配层均未调用；Compressor / LlmSummarizer / FallbackSummarizer 仅测试引用 |
| 多模型角色路由 | model-router.ts · ModelRole 含 4 角色 | 全项目仅 getClient('main') 被调用（agent-loop.ts:150）；planner 直接注入主模型 llm（runtime.tsx:322） |
| 语义记忆 | injector.ts + extractor.ts | 仅测试引用；system prompt 为写死常量（runtime.tsx:61 / server config.ts:34 / task-runner.ts:62） |
| 目标漂移提醒 | goal-tracker.ts | GoalTracker 在 runtime.tsx 建后只传 UI；checkDrift() / toSystemPromptInjection() 仅测试调用；AgentLoop 无 goal 依赖 |
| 写前自动快照 | checkpoint.ts | write_file 检查 ctx.snapshotBeforeWrite（fs.ts:95），但 AgentLoop.executeTool 调 tool.run 未传该回调（agent-loop.ts:204），auto_write 检查点永不产生 |

### 3.2 效率问题

- 工具串行执行：for (const toolCall of resp.toolCalls) 逐个 await（agent-loop.ts:136）。
- LLM 调用无超时/无 AbortSignal：gateway.ts 与两个 provider 的 chat 均无 signal；interrupt() 只在两次 LLM 调用之间检查（agent-loop.ts:118），正在进行的流式请求会完整跑完并计费。

### 3.3 成本问题

- 无价格表：CostTracker 只累计 input/output token（cost-tracker.ts），无模型单价，无金额成本。
- 无 Prompt Caching：provider 未传 cache_control（anthropic.ts:67 / openai-compat.ts:70），稳定前缀（system + tools）每步重复计费。
- 每步重发全量工具 schema：toRequest 每步 tools.specs()（agent-loop.ts:254），MCP 巨型 schema 尤其吃 token。
- 规划探索上下文被丢弃：Planner.plan() 返回 explorationMessages，runtime.tsx 只取 plan 丢弃探索消息，执行阶段重复读同一批文件。

### 3.4 准确率问题

- stopReason === max_tokens 被无视：provider 已正确映射（openai-compat.ts:173），但 AgentLoop 从不消费 resp.stopReason，截断输出被当作完整结果（toolCalls.length === 0 即 done）。
- temperature 不可配：AgentLoopDeps.temperature 可选但三处装配层均未传（runtime.tsx:290），落到 provider 默认值。
- token 估算纯启发式且无反馈：estimateTokens 宽字符 1:1 / 其余 4:1（tokens.ts），logTokenCalibration 只打 debug 日志不回写（agent-loop.ts:130）。
- 裁剪丢内容：tool_result 被省略后仅留占位符（context-manager.ts:85），模型拿不到内容。

---

## 4. 目标与非目标

### 4.1 本期目标

- 把 3.1 的五处死代码接入 CLI / server / daemon 运行时。
- 工具并行执行、LLM 超时与中断中止。
- 成本计量（价格表 + CostTracker 出真钱数）、Prompt Caching、工具 schema 精简、规划上下文复用。
- token 估算校准、web 结果缓存、结构化错误分类。

### 4.2 非目标

- 不重写 agent-loop 主循环结构（保持事件溯源 + 端口-适配器不变）。
- 不引入新的 LLM 推理框架（如 LangGraph）；保持自研 loop。
- 动态工具选择（按步骤挑选工具子集）作为后续可选，本期仅做 schema 精简。
- Web UI 中「手动录入模型单价」的完整 CRUD 本期不做（仅内置价格表 + env/config 覆盖）。
- 多租户成本计费 / 账单导出。

---

## 5. 术语

| 术语 | 含义 |
|---|---|
| 角色（ModelRole） | main / planner / compressor / extractor，决定「哪个模型干什么」 |
| 接线 | 把已实现的类/回调注入到运行时装配层（runtime.tsx / session-manager.ts / task-runner.ts） |
| 压缩（Compress） | 用 LLM 摘要替换超预算上下文，区别于「省略（Elide）」式硬截断 |
| Prompt Caching | 对稳定前缀（system + tools）做缓存，降低输入 token 成本（Anthropic 显式 cache_control；DeepSeek 自动上下文缓存） |
| 校准系数（Calibration Ratio） | 实际 inputTokens / 估算 tokens 的累积比值，用于修正启发式估算 |

---

## 6. 总体架构与优化分层

优化不改动现有分层，只做三类动作：

1. 装配层注入（cli/server/daemon 的 new AgentLoop 处）：把已实现的依赖注入进去。
2. 端口扩展（types 层）：Usage 扩展缓存字段、ToolResult 扩展结构化错误、ChatOptions 扩展 signal 等。
3. Provider 协议层：cache_control、signal 透传、缓存用量回报。

分层示意（灰框为本期改动点）：

    装配层 runtime.tsx / session-manager.ts / task-runner.ts   ← 注入 compressor / planner角色 / 快照 / 记忆 / goal
    AgentLoop（不重构，只加可选依赖与 hook）                     ← 并行执行 / 中断中止 / max_tokens续写
      ├ ContextManager（加 compressor 接线 + 校准系数）
      ├ TurnBudget（不变）
      └ GoalTracker hook（新增注入点）
    Router（planner/compressor/extractor 角色启用）
    CostTracker（加价格表 → 成本）
    LLMGateway（加超时/abort/重试预算）
    Providers（cache_control / signal / 缓存用量回报）

---

## 7. Phase 1：接线（最高优先级）

目标：把已实现、已测的 5 处能力接入运行时。改动集中在装配层与 AgentLoop 的可选依赖，风险最低、收益最高。本 Phase 完成后，README 声称的能力在代码层面真正生效。

### 7.1 写前自动快照接线

现状：ExecutionContext.snapshotBeforeWrite 与 currentSeq 字段已定义（types/tools.ts:33），write_file 已消费（fs.ts:95），但 AgentLoop 调 tool.run 时未传入（agent-loop.ts:204）。CheckpointManager 已实现（checkpoint.ts）。

方案：

1. AgentLoopDeps 新增可选依赖：

        export interface AgentLoopDeps {
          // ...现有字段
          /** 写前快照回调；undefined = 禁用（测试/无检查点场景） */
          checkpoint?: {
            snapshotBeforeWrite: (relPath: string, seq: number) => Promise<string>;
          };
        }

2. executeTool 中，tool_call 事件 append 后取得 envelope.seq 作为 currentSeq，并在调用 tool.run 时传入 snapshotBeforeWrite 与 currentSeq。appendAndPush 的返回值从 void 改为 EventEnvelope（append 内部已拿到 envelope，直接透传即可）。

        const toolCallEnvelope = await this.appendAndPush({
          type: 'tool_call', callId: toolCall.callId, toolName: toolCall.toolName, args: toolCall.args,
        });
        const snapshotBeforeWrite = this.deps.checkpoint
          ? (relPath: string) => this.deps.checkpoint!.snapshotBeforeWrite(relPath, toolCallEnvelope.seq)
          : undefined;
        result = await tool.run(toolCall.args, {
          sessionId, cwd, logger, sandbox,
          ...(snapshotBeforeWrite !== undefined ? { snapshotBeforeWrite } : {}),
          currentSeq: toolCallEnvelope.seq,
        });

3. CLI 装配层（runtime.tsx）在 checkpointing.enabled 时注入：

        const checkpointMgr = checkpointStore !== undefined
          ? new CheckpointManager(checkpointStore, session.id)
          : undefined;
        // AgentLoopDeps:
        checkpoint: checkpointMgr !== undefined
          ? { snapshotBeforeWrite: (relPath, seq) => checkpointMgr.snapshotBeforeWrite(session.cwd, relPath, seq) }
          : undefined,

涉及文件：core/core/agent-loop.ts、core/core/ports.ts（如签名复用）、cli/src/cli/runtime.tsx、core/tests/core/agent-loop.test.ts、core/tests/tools/fs.test.ts（补充 loop 层集成断言）。

验收标准：

- write_file 执行前产生 source: 'auto_write' 检查点；/undo 能回滚到写前状态。
- loop 未注入 checkpoint 时，tool.run 收到 ctx 不含 snapshotBeforeWrite（向后兼容，现有测试不破）。
- 新增单测：AgentLoop 注入 checkpoint 后，write_file 调用链携带 snapshotBeforeWrite + 正确的 currentSeq。

### 7.2 自适应压缩接线（compressor + 角色）

现状：ContextManager.setCompressor() 存在但从未被调用；LlmSummarizer（调 LLM）、FallbackSummarizer（零成本截断）均已实现并测过。

方案：

1. 装配层构建 Summarizer：配置了 modelRoles.compressor 时用 router.getClient('compressor') 构建 LlmSummarizer；否则用 FallbackSummarizer（不调 LLM，零成本，保证长对话不超窗）。再包一层 Compressor。

        const compressorClient = router.getClient('compressor'); // 未配置时回退 main（router 已实现回退）
        const summarizer = new LlmSummarizer(compressorClient);
        const compressor = new Compressor(summarizer, {
          triggerRatio: config.compression?.triggerRatio ?? 0.7,
          maxTokensPerSummary: config.compression?.maxTokensPerSummary ?? 200,
          keepRecent: config.compression?.keepRecent ?? 4,
        });
        context.setCompressor(compressor);

2. 角色命名对齐：README/config 示例用 summarize，但 ModelRole 与 buildModelRoles 已用 compressor。统一为 compressor，并更新 README 与 .env.example；buildModelRoles 已支持 compressor 键（config.ts:344），无需改代码。

3. 关键语义确认（已实现，接线后生效）：context.push() 已调用 compressor.clearCache()（context-manager.ts:138），避免索引偏移导致缓存错位；压缩只替换最早的消息，保留区（最近 keepRecent 条 + 最后一条 user）不压缩（compressor.ts getProtectedIndices）；压缩后仍超预算时降级到 ContextManager 的省略式截断（compressor.ts 阶段 3）。

涉及文件：cli/src/cli/runtime.tsx、server/src/session-manager.ts、core/src/daemon/task-runner.ts（三处接线）、README.md（键名对齐）、core/tests/core/compressor.test.ts（已存在）。

验收标准：

- 长对话超阈值时，较早 tool_result 被替换为 [summary] ... 而非占位符。
- 配置 modelRoles.compressor 后，压缩调用走该角色模型，CostTracker 记录 role: 'compressor'。
- 未配置 compressor 角色时，走 FallbackSummarizer（或 main 回退），长对话不超窗。
- 现有 compressor/summarizer 单测全绿。

### 7.3 规划器角色分派

现状：Planner 直接注入主模型 llm（runtime.tsx:322 / :339）；ModelRole.planner 已定义但未用。

方案：装配层改注入 router.getClient('planner')（未配置回退 main）：

        const plannerLlm = router.getClient('planner');
        // 两处 new Planner({ llm: plannerLlm, ... })

Planner 自身依赖不变（仍为 LLMClient 端口），只改装配层。

涉及文件：cli/src/cli/runtime.tsx。

验收标准：配置 modelRoles.planner 后规划阶段走该模型，CostTracker 记录 role: 'planner'；未配置时回退 main（行为不变）。

### 7.4 temperature 可配置（子任务固定为 0）

现状：AgentLoopDeps.temperature 可选但未传；Summarizer/Planner 的 chat 请求不传 temperature。

方案：

1. 配置层新增（顶层 + 可选 per-role）：

        interface AppConfig {
          // ...
          temperature?: number;                    // 主对话，可选
          roleTemperature?: Partial<Record<ModelRole, number>>; // 角色级覆盖
        }

2. 确定性任务固定 temperature: 0：planner、compressor、extractor 三个子任务的 chat 请求默认 temperature: 0（提高结构化输出/摘要/提取的稳定性）。主对话不强制，仅当配置了 temperature 才透传。

3. 装配层把 config.temperature 传入 AgentLoopDeps.temperature（现有 toRequest 已支持）。

涉及文件：core/src/config/config.ts、cli/src/cli/runtime.tsx、server/src/config.ts、core/src/core/planner.ts、core/src/core/summarizer.ts、core/src/memory/extractor.ts。

验收标准：子任务请求携带 temperature: 0；主对话仅在配置后携带 temperature；契约测试补充 temperature 字段断言。

### 7.5 max_tokens 截断续写

现状：resp.stopReason 已正确映射 'max_tokens'，但 AgentLoop 从不消费，截断输出当完整结果。

方案：

1. AgentLoop 在 chat() 返回后检查：

        const resp = await this.chat(built.messages);
        if (resp.stopReason === 'max_tokens') {
          this.truncationCount += 1;
          if (this.truncationCount >= MAX_CONTINUATIONS /* 默认 3 */) {
            // 连续截断熔断：按当前输出收尾
            return 'done';
          }
          // 落库 assistant_text（已截断）后，注入续写指令并继续循环
          await this.appendAndPush({ type: 'assistant_text', text: resp.text, toolCalls: resp.toolCalls });
          await this.appendAndPush({
            type: 'user_input',
            content: '[上一回复因达到 max_tokens 被截断，请从被截断处继续，不要重复已输出内容]',
          });
          continue;
        }
        this.truncationCount = 0;

2. truncationCount 每次 turn 重置（runTurn 开头 this.truncationCount = 0）。

3. 边界：toolCalls 存在但 args 被截断时，parseToolArgs 的容错结果可能不完整——同样走续写分支（把不完整 toolCalls 落库并注入续写）。若 args 解析抛错，provider 已降级为 []，此时走纯文本续写。

涉及文件：core/src/core/agent-loop.ts、core/src/types/events.ts（如需标记 truncation 事件，可选）、core/tests/core/agent-loop.test.ts。

验收标准：截断响应自动续写并合并；连续 3 次截断不无限循环；现有测试不破。

---

## 8. Phase 2：结构改进

### 8.1 语义记忆注入 + 提取接线

现状：MemoryInjector / MemoryExtractor 仅测试引用；system prompt 写死；server 端 StorageBackend.memories 已实现（routes/memories.ts），CLI 端有 core/storage/memory-store.ts。

方案：

1. 注入：装配层在构建 system prompt 时调用 MemoryInjector.inject()，把 <semantic-memory>...</semantic-memory> 片段拼接到 system prompt 尾部。

   - CLI：new MemoryInjector(new SqliteMemoryStore(db))，启动时 await injector.inject()；
   - server：session-manager 用 StorageBackend.memories 包装成 MemoryStore 端口（或直接复用 listActive）。

        const memoryFragment = await memoryInjector.inject(); // '' 表示无记忆
        const systemPrompt = memoryFragment
          ? BASE_SYSTEM_PROMPT + '\n\n' + memoryFragment
          : BASE_SYSTEM_PROMPT;

2. 提取：会话（turn）结束时调用 MemoryExtractor.extract()：

   - 触发点：finishTurn 或装配层的 turn_completed 事件监听处；
   - 输入：eventStore.replay(sessionId) 的全部事件 + 已有记忆标题（去重）；
   - 用 router.getClient('extractor')（未配置回退 main），temperature: 0；
   - 失败静默（log warn），不阻断会话。

3. 去重/数量控制：extract() 已按 existingTitles 去重；注入端建议加「最近 N 条 + 关键词过滤」以避免记忆膨胀（本期先全量注入，保留注入器注释的 <200 条、约 2k token 假设）。

涉及文件：core/src/memory/injector.ts（已实现）、core/src/memory/extractor.ts（已实现）、cli/src/cli/runtime.tsx、server/src/session-manager.ts、core/src/daemon/task-runner.ts（可选）。

验收标准：跨会话偏好/事实出现在新会话 system prompt；会话结束自动提取记忆并落库；提取失败不阻断会话。

### 8.2 目标追踪注入

现状：GoalTracker 仅 UI 展示；AgentLoop 无 goal 依赖。

方案：AgentLoop 增加可选 goal hook：

        export interface AgentLoopDeps {
          // ...
          /** 目标追踪 hook；undefined = 禁用 */
          goalTracker?: {
            /** 每步调用，返回需注入的提醒文本（undefined = 不注入） */
            checkDrift(currentStep: number, recentToolCalls: ToolCall[]): string | undefined;
            /** 拼进 system prompt 的目标摘要 */
            systemPromptInjection(): string | undefined;
          };
        }

1. 装配层把 GoalTracker 注入（runtime.tsx 已创建 goalTracker，改传入 loop）。
2. toRequest 构建时把 goalTracker.systemPromptInjection() 拼进 system prompt（与记忆片段并列）。
3. 每步 chat 前（context.build() 后）调 checkDrift，返回提醒时作为临时消息 push 到本轮消息末尾再调 LLM。

涉及文件：core/src/core/agent-loop.ts、cli/src/cli/runtime.tsx、core/tests/core/agent-loop.test.ts。

验收标准：长任务每 driftThreshold 步注入目标提醒；system prompt 含当前目标；未初始化 goal 时零开销。

### 8.3 并行工具执行

现状：串行 for (const toolCall of resp.toolCalls)（agent-loop.ts:136）。

方案（保守策略，保证确定性 + 消息结构合法）：

1. 分桶：同一 assistant 消息的 toolCalls 按 risk 分组——全部 read/net 时并发执行；含任一 write/danger 时串行（写操作可能有依赖/冲突，保守）。
2. 审批先行：审批阶段仍逐个收集（审批本身需要用户逐个确认），审批通过后的执行阶段并发 Promise.all。
3. 顺序落库：tool_result 事件仍按 callId 原始顺序 append（保证事件重放确定、Anthropic 连续 tool 消息合并合法）。执行结果先存 Map，再按序 appendAndPush。
4. 中断语义：interrupt() 在「当前批次结束后、下一次 LLM 调用前」生效（与现有语义一致，从单工具扩大到单批次）。

涉及文件：core/src/core/agent-loop.ts（executeTools 重写为批量）、core/tests/core/agent-loop.test.ts。

验收标准：多读工具并发执行，墙钟时间下降；事件重放顺序与串行一致；写/危险工具仍串行；现有测试不破。

### 8.4 LLM 请求超时 + 中断中止

现状：无 signal，interrupt() 只在 step 间。

方案：

1. ChatOptions 扩展：

        export interface ChatOptions {
          onTextDelta?: (delta: string) => void;
          signal?: AbortSignal;   // 新增
        }

2. Provider 透传：transport.create/createStream 增加 { signal }（OpenAI/Anthropic SDK 均支持）；流式折叠循环捕获 abort 错误抛出 TransientError（或专门的 AbortError）。
3. Gateway 超时：LLMGatewayConfig 新增 requestTimeoutMs（默认 120000），用 AbortSignal.timeout 与外部 signal 合并（AbortSignal.any）。
4. AgentLoop 中断：runTurn 开头创建 this.turnAbort = new AbortController()；interrupt() 里 this.turnAbort.abort()；chat() 调用传入 signal: this.turnAbort.signal；chat 抛 abort 错误时，runSteps 捕获并返回 'interrupted'（需区分 abort 与其他 LlmStageError）。

涉及文件：core/src/types/llm.ts、core/src/llm/gateway.ts、core/src/llm/providers/anthropic.ts、core/src/llm/providers/openai-compat.ts、core/src/core/agent-loop.ts、core/tests/llm/*.test.ts。

验收标准：Ctrl+C 立即中止流式（不烧完整个回复）；超时请求按时中止并按 TransientError 重试；现有契约测试不破（signal 可选，默认不传）。

---

## 9. Phase 3：成本治理

### 9.1 成本计量（价格表 + CostTracker）

现状：CostTracker 只累计 token（cost-tracker.ts），无单价、无金额。

方案：

1. 新增 core/src/types/pricing.ts：

        export interface ModelPrice {
          inputPerMillion: number;    // USD / 1M tokens
          outputPerMillion: number;   // USD / 1M tokens
          cachedInputPerMillion?: number; // 缓存输入（Anthropic）
        }
        export type PricingTable = Record<string, ModelPrice>; // key: provider + '/' + model

        export function estimateCost(
          usage: Usage,
          price: ModelPrice | undefined,
        ): number | undefined; // undefined = 无价格

2. 内置默认价格表 core/src/llm/pricing.ts（Anthropic Claude 系列、DeepSeek 官方价；后续补充豆包/Kimi/OpenRouter）。config 支持 pricing 覆盖。

3. CostTracker.record() 增加价格参数，summaryByRole()/total() 增加 cost 汇总：

        record(usage: RoleUsage, price?: ModelPrice): void;
        total(): { inputTokens: number; outputTokens: number; cachedInputTokens: number; cost?: number };

4. 展示：CLI 状态栏 + Web UI 会话侧显示累计 token 与金额成本。

涉及文件：core/src/types/pricing.ts（新）、core/src/llm/pricing.ts（新）、core/src/router/cost-tracker.ts、core/src/types/router.ts（RoleUsage 扩展）、cli/src/cli/renderer.ts、server 侧运行时（costTracker 消费）。

验收标准：turn 结束后可显示本次/累计成本；fake provider 无价格时仅显示 token；价格表覆盖可配置。

### 9.2 Prompt Caching

现状：无 cache_control，稳定前缀每步重复计费。

方案：

1. Usage 扩展缓存字段（types/events.ts）：

        export interface Usage {
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens?: number;   // 缓存命中输入 token（Anthropic cache_read_input_tokens）
        }

   inputTokens 语义保持 prompt_tokens（含缓存部分），预算逻辑不变；缓存字段仅供成本核算。

2. Anthropic：system 块与 tools 定义加 cache_control: { type: 'ephemeral' }（5 分钟 TTL，稳定前缀天然可缓存）。实现位置：构建 system 时给 system 块加 cache_control；toAnthropicTools 最后一个 tool 加 cache_control。
3. OpenAI 兼容（DeepSeek）：DeepSeek 自动上下文缓存，无需显式标记；确保 system + tools 前缀每次字节级稳定（当前 registry 顺序稳定、tools.specs() 顺序稳定，满足条件）。
4. Cache 命中回报：Anthropic message_start/usage 里读 cache_read_input_tokens、cache_creation_input_tokens，回填 Usage.cachedInputTokens。

涉及文件：core/src/types/events.ts、core/src/llm/providers/anthropic.ts、core/src/llm/providers/openai-compat.ts、core/src/router/cost-tracker.ts、core/tests/llm/providers/anthropic.test.ts。

验收标准：Anthropic 请求带 cache_control；usage 含缓存 token；成本核算区分缓存与非缓存输入；缓存字段可选，不影响现有断言。

### 9.3 工具 schema 精简

现状：每步 tools.specs() 全量下发，MCP 巨型 schema 吃 token。

方案（第一期只做精简不做动态选择）：

1. ToolRegistry.specs(mode?: 'full' | 'compact')：

   - full：现状（向后兼容）；
   - compact：保留 name/description，inputSchema 仅保留 type 与顶层属性名列表（去掉子结构、枚举、description 字段）。

2. MCP 工具的 schema 直传，在 compact 模式下同样裁到顶层属性名。
3. 配置开关 config.toolsSchemaMode（默认 full，可切 compact）。

动态工具选择（按步骤用便宜模型挑选工具子集）作为后续可选，本期列为非目标。

涉及文件：core/src/tools/registry.ts、core/src/core/agent-loop.ts（toRequest 传入 mode）、core/src/config/config.ts。

验收标准：compact 模式下 MCP 场景每步输入 token 显著下降；full 模式行为不变。

### 9.4 规划探索上下文复用

现状：Planner.plan() 返回 explorationMessages，runtime.tsx 丢弃。

方案：

1. 装配层把 explorationMessages 转化为「探索摘要」注入执行阶段 system prompt（而非重复推送原始消息，避免双倍上下文）：

   - 取探索消息中 tool 角色结果（读到的文件内容/结论）做一次摘要（复用 LlmSummarizer，compressor 角色）；
   - 摘要 + 结构化 plan 一起作为执行 loop 的 system prompt 附件。

2. 简化版（先落地）：把 plan JSON 注入执行 system prompt，探索的 tool_result 直接丢弃（现状），但至少把 plan 注入，让执行阶段按计划推进（减少漂移、减少重复探索）。

涉及文件：core/src/core/planner.ts（已返回）、cli/src/cli/runtime.tsx、server（如有 planner）。

验收标准：规划后执行阶段 system prompt 含结构化 plan；执行阶段不重复读规划阶段已读的文件（摘要复用生效时）。

---

## 10. Phase 4：持续优化

### 10.1 token 估算校准

方案：新增 TokenCalibrator（core/src/utils/tokens.ts 内）：

        export class TokenCalibrator {
          private ratios = new Map<string, number>(); // key: provider + '/' + model
          observe(provider: string, model: string, estimated: number, actual: number): void; // EMA 更新
          ratio(provider: string, model: string): number; // 默认 1.0
        }

- AgentLoop.chat() 的 logTokenCalibration 改为 calibrator.observe()；
- ContextManager 构造注入可选 calibrator，estimateTokens 结果 × ratio（校正预算决策）；
- 持久化：先内存（进程级），后续可选写入 config。

涉及文件：core/src/utils/tokens.ts、core/src/core/context-manager.ts、core/src/core/agent-loop.ts。

验收标准：估算与实际偏差收敛；校准系数可在 debug 日志观察；不注入时行为不变。

### 10.2 web 结果缓存

方案：web_fetch / web_search 增加 turn 级（或带 TTL 会话级）缓存：

        const cache = new Map<string, { content: string; ts: number }>();
        const WEB_CACHE_TTL_MS = 5 * 60 * 1000;

- 键：web_fetch + ':' + url / web_search + ':' + provider + ':' + query + ':' + maxResults；
- 命中且未过期直接返回（标记 data: { cached: true }）。

涉及文件：core/src/tools/web.ts。

验收标准：同 turn 内重复 URL/query 只请求一次；跨 turn 超 TTL 后重新请求。

### 10.3 结构化错误分类

方案：ToolResult 增加可选 errorKind：

        export interface ToolResult {
          ok: boolean;
          content: string;
          data?: unknown;
          errorKind?: 'transient' | 'permanent' | 'usage';  // 新增
        }

- AgentLoop.executeTool 的 isTransientError(result.content) 改为优先读 result.errorKind（transient → 重试，permanent/undefined → 回退子串匹配，usage → 立即返回不重试）；
- 各工具逐步改用结构化错误，取代 msg.includes('timeout') 嗅探。

涉及文件：core/src/types/tools.ts、core/src/types/errors.ts（isTransientError 扩展）、core/src/core/agent-loop.ts、core/src/tools/fs.ts、core/src/tools/shell.ts、core/src/tools/web.ts。

验收标准：错误分类不再依赖脆弱子串；重试行为与现状兼容。

---

## 11. 数据模型与迁移

| 变更 | 存储 | 迁移 |
|---|---|---|
| Usage 缓存字段 | 内存 + 事件流（turn_completed.usage） | 事件 payload 增字段，旧事件重放时缺省为 undefined，无需迁移 |
| 价格表 | config.json / 内置默认 / Web UI（后续） | 本期无 DB 迁移；Web UI 录入单价列为后续 |
| TokenCalibrator | 内存（先）/ config（后续） | 无 |
| web 缓存 | 内存 | 无 |
| CostTracker cost | 内存聚合 | 无 |

结论：本期零数据库迁移。所有新增均走内存 + config，事件 payload 只增字段（向后兼容）。

---

## 12. 配置项汇总

在 ~/.yo-harness/config.json 新增（均为可选，缺省保持现状）：

    {
      "temperature": 0.2,
      "roleTemperature": { "planner": 0, "compressor": 0, "extractor": 0 },
      "modelRoles": {
        "main":       { "provider": "anthropic",  "model": "claude-sonnet-4-5" },
        "planner":    { "provider": "anthropic",  "model": "claude-haiku-3-5" },
        "compressor": { "provider": "anthropic",  "model": "claude-haiku-3-5" },
        "extractor":  { "provider": "anthropic",  "model": "claude-haiku-3-5" }
      },
      "compression": {
        "triggerRatio": 0.7,
        "maxTokensPerSummary": 200,
        "keepRecent": 4
      },
      "llm": {
        "requestTimeoutMs": 120000,
        "promptCaching": true
      },
      "pricing": {
        "anthropic/claude-sonnet-4-5": { "inputPerMillion": 3.0, "outputPerMillion": 15.0, "cachedInputPerMillion": 0.30 }
      },
      "toolsSchemaMode": "full"
    }

modelRoles 键名从 README 旧的 summarize 统一为 compressor（与 ModelRole 类型一致）。

---

## 13. 实施路线图

| 里程碑 | 内容 | 依赖 | 验收门槛 | 预估 |
|---|---|---|---|---|
| M1（接线） | 7.1 快照 · 7.2 压缩 · 7.3 planner 角色 · 7.4 temperature · 7.5 max_tokens | 无 | 五处能力在 CLI/server/daemon 生效，现有单测全绿 | 1 周 |
| M2（结构） | 8.1 记忆 · 8.2 goal · 8.3 并行 · 8.4 超时/中止 | M1 | 长对话漂移/记忆/中断/并行均生效，契约测试不破 | 1 周 |
| M3（成本） | 9.1 价格表 · 9.2 caching · 9.3 schema · 9.4 规划复用 | M1（部分）、M2 | 可显示成本、缓存命中率、MCP 场景输入 token 下降 | 1 周 |
| M4（持续） | 10.1 校准 · 10.2 web 缓存 · 10.3 错误分类 | M1 | 估算偏差收敛、重复请求下降、错误分类结构化 | 持续 |

每个里程碑独立可交付、独立可回滚；M1 是解锁后续的关键路径。

---

## 14. 风险与回滚

| 改动 | 风险 | 缓解 / 回滚 |
|---|---|---|
| 压缩接线 | 摘要模型引入幻觉，丢关键信息 | FallbackSummarizer 兜底；保留区不压缩；triggerRatio 可调；关闭开关即回退纯省略 |
| 并行执行 | 事件顺序/审批交互/写依赖 | 仅 read/net 并发，写/danger 串行；按 callId 顺序落库保证重放确定；开关回退串行 |
| 中断中止 | SDK abort 异常类型差异、半途状态 | signal 可选默认不传；契约测试覆盖两类 SDK；关闭即回退 step 间检查 |
| max_tokens 续写 | 死循环 | 连续 3 次熔断；turn 级计数器 |
| Prompt Caching | 缓存失效/计费口径 | 缓存字段可选；inputTokens 语义不变（预算不受影响）；关闭缓存开关 |
| 记忆注入 | 注入膨胀、跨会话误导 | 数量上限 + 关键词过滤（后续）；本期全量注入有约 2k token 上限假设 |

---

## 15. 验收标准总表

| # | 项 | 可测信号 |
|---|---|---|
| 1 | 写前快照 | write_file 前产生 auto_write 检查点，/undo 可回滚 |
| 2 | 自适应压缩 | 超阈值 tool_result 变 [summary]，CostTracker 记 compressor 角色 |
| 3 | planner 角色 | 规划走 planner 模型，CostTracker 记 planner 角色 |
| 4 | temperature | 子任务 temperature=0；主对话仅配置后透传 |
| 5 | max_tokens 续写 | 截断续写成功，连续 3 次熔断 |
| 6 | 记忆注入/提取 | 新会话 system prompt 含跨会话记忆；会话结束自动提取 |
| 7 | 目标注入 | 每 driftThreshold 步注入提醒；system prompt 含 goal |
| 8 | 并行执行 | 多读工具并发，重放顺序确定，写工具串行 |
| 9 | 超时/中止 | Ctrl+C 立即中止流式；超时按 TransientError 重试 |
| 10 | 成本计量 | 显示 token + 金额成本；无价格时仅 token |
| 11 | Prompt Caching | Anthropic 带 cache_control，usage 含缓存 token |
| 12 | schema 精简 | compact 模式 MCP 场景输入 token 下降 |
| 13 | 规划复用 | 执行阶段 system prompt 含 plan，减少重复探索 |
| 14 | token 校准 | 估算/实际比值收敛 |
| 15 | web 缓存 | 同 turn 重复 URL/query 只请求一次 |
| 16 | 错误分类 | 结构化 errorKind 取代子串嗅探 |

---

## 16. 文件变更清单

### 新增

- packages/core/src/types/pricing.ts — 价格表类型 + estimateCost 纯函数
- packages/core/src/llm/pricing.ts — 内置默认价格表

### 修改（core）

- packages/core/src/core/agent-loop.ts — 快照接线、并行执行、max_tokens 续写、goal hook、中断中止、温度透传、token 校准
- packages/core/src/core/context-manager.ts — 校准系数
- packages/core/src/core/planner.ts — temperature=0、子任务参数
- packages/core/src/core/summarizer.ts — temperature=0
- packages/core/src/memory/extractor.ts — temperature=0
- packages/core/src/router/cost-tracker.ts — 价格 + cost 汇总
- packages/core/src/router/model-router.ts — 角色消费（无需改，验证即可）
- packages/core/src/types/llm.ts — ChatOptions.signal
- packages/core/src/types/events.ts — Usage.cachedInputTokens
- packages/core/src/types/router.ts — RoleUsage 扩展缓存字段
- packages/core/src/types/tools.ts — ToolResult.errorKind
- packages/core/src/types/errors.ts — isTransientError 支持 errorKind
- packages/core/src/llm/gateway.ts — 超时、abort、重试预算
- packages/core/src/llm/providers/anthropic.ts — cache_control、signal、缓存用量
- packages/core/src/llm/providers/openai-compat.ts — signal、缓存用量
- packages/core/src/tools/registry.ts — specs('full'|'compact')
- packages/core/src/tools/web.ts — 缓存、结构化错误
- packages/core/src/tools/fs.ts — 结构化错误（errorKind）
- packages/core/src/tools/shell.ts — 结构化错误（errorKind）
- packages/core/src/config/config.ts — temperature、roleTemperature、pricing、toolsSchemaMode、llm
- packages/core/src/utils/tokens.ts — TokenCalibrator

### 修改（装配层）

- packages/cli/src/cli/runtime.tsx — 注入 checkpoint/compressor/planner角色/记忆/goal/temperature
- packages/server/src/session-manager.ts — 同上述注入
- packages/server/src/config.ts — 新配置项默认值
- packages/core/src/daemon/task-runner.ts — 同上述注入（可选）
- packages/cli/src/cli/renderer.ts — 成本展示

### 修改（文档）

- README.md — modelRoles 键名对齐（summarize → compressor）、新配置项说明

### 测试

- 每个改动点补集成/契约测试（见各小节「验收标准」）；现有 pnpm --filter @yo-harness/core run test 必须全绿。
