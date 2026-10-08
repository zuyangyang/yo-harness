# yo-harness 审批流（Human-in-the-loop）设计文档

> 版本 v1.0 · 2026-10-08 · 状态：待评审
> 范围：审批的端到端流程 —— core 权限引擎、server 广播/排队/落库、web 交互入口、三级权限模式、自动审批风险引擎
> 覆盖层次：core（权限引擎 + 事件）、server（SessionManager + WS Hub + REST）、web（状态 + 组件 + 交互）、cli（语义对齐）
> 关联文档：docs/UI-REDESIGN.md（前端 IA/组件规范）、docs/SESSION-WORKSPACE-DESIGN.md（会话/工作区）、docs/CHAT-DISPLAY-REDESIGN.md（对话区 Turn 化）
> 关联代码：packages/core/src/core/permission.ts · packages/server/src/session-manager.ts · packages/server/src/ws/hub.ts · packages/web/src/layout/AppShell.tsx · packages/web/src/components/Approval/ApprovalDialog.tsx

## 目录

1. 摘要（TL;DR）
2. 背景与问题：线上 bug 复现与根因
3. 目标与非目标
4. 术语与审批状态机
5. 竞品参考与模式取舍
6. 三级权限模式设计
7. 自动审批（Auto）风险引擎设计
8. 端到端流程与时序
9. 协议与服务端设计
10. 数据模型与迁移
11. 前端交互设计（入口 / 组件 / 线框）
12. 前端状态管理
13. 事件与审计
14. 安全与边界（含多租户）
15. 兼容性与迁移
16. 实施路线图与文件清单
17. 测试策略
18. 验收标准
19. 风险与开放问题
- 附录 A：自动审批风险规则表
- 附录 B：文案（中英）
- 附录 C：参考链接

---

## 1. 摘要（TL;DR）

当前「需要审批」时 Web UI 没有可用的审批入口，**不是前端组件缺失，而是服务端从未把审批请求推给浏览器**：

- 服务端在 `SessionManager.serverAsk`（packages/server/src/session-manager.ts:237-250）创建了 `PendingApproval` 并把 Promise 挂起，但**从未调用** `wsHub.broadcastApprovalRequest()`（packages/server/src/ws/hub.ts:128 定义，全仓无生产调用方）。因此浏览器永远收不到 `approval.request`，`useApprovalStore.pendingApprovals` 恒为空，`AppShell` 里的 `ApprovalDialog` 永不渲染。
- 用户只能看到工具卡片的只读文案 `Waiting approval: …`（来自已落库并广播的 `approval_request` **事件**，见 packages/web/src/components/Chat/ToolSteps.tsx:73-77），无法决策，Agent 轮次永久挂起。
- 另有两处缺陷：`ApprovalDialog` 遮罩点击即 `onDismiss`→从 store 移除但**不 resolve 服务端**（AppShell.tsx:79），造成「关掉弹窗就再也回不来」；REST 待审批接口（packages/server/src/routes/approvals.ts:20-24）返回的字段名是 `id`，而 Web 类型期望 `approvalId`（packages/web/src/api/client.ts:231-237），且该接口无人轮询/刷新后不恢复。

本设计给出完整目标方案，分四层：

1. **入口（需求 1）**：以「对话内联审批卡」为主入口，辅以「输入框上方常驻待办条」「顶栏/侧栏角标」「系统通知」，并给出会话切换、刷新、断线重连后的恢复策略。
2. **三级权限模式（需求 2）**：在输入框左下角提供 `询问审批 / 自动审批 / 完全访问` 下拉，与 core 的权限模型、会话持久化、服务端执行打通。
3. **自动审批引擎**：借鉴 OpenAI Codex 的 approval mode × sandbox、Claude Code 的 allow/deny 规则、OpenHands SecurityAnalyzer 的确定性风险分析，落地为「确定性规则引擎 + 工作区边界 + 会话学习白名单 + 每轮自动放行预算 + 失败关闭」的可审计方案。
4. **修复与加固**：广播、重放、取消、超时、多标签页同步、多租户越权。

实施建议：先做 **P0（bug 修复 + 恢复 + 弹窗不可静默丢弃）**，再做 **P1（内联审批卡 + 模式选择器）**，最后做 **P2（自动审批引擎 + 设置页）**。详见 §16。

---

## 2. 背景与问题：线上 bug 复现与根因

### 2.1 复现步骤（与截图一致）

1. Web 新建会话，发送「记住我叫 yang yang」。
2. 模型调用 `write_file`（`path: notes/user.md`）。
3. 界面出现工具卡片 `write_file  notes/user.md … Waiting approval: write_file notes/user.md (23 chars)`，右下角持续「正在生成…」。
4. **界面上没有任何按钮可以批准或拒绝**，会话永久卡住。

### 2.2 根因链路

```text
AgentLoop → permission.request()
        → withApprovalEvents(serverAsk, sink)          // core/permission.ts:164
            sink(approval_request 事件)  ──► EventBus ──► hub.broadcast()  ──► 浏览器收到 'event'
        → serverAsk(request)                           // session-manager.ts:237
            创建 PendingApproval + Deferred，挂起
            ✗ 没有 hub.broadcastApprovalRequest(...)    // ← 断链点
        → 浏览器 useApprovalStore 永远为空
        → AppShell 不渲染 ApprovalDialog
```

**证据**：`grep -rn broadcastApprovalRequest` 仅命中 hub.ts 的定义与 hub.test.ts 的测试，无生产调用。`useWebSocket()` 已在 App.tsx:30 注册 `approval` 监听，`wsClient.subscribe(sessionId)` 在选会话时调用（stores/session.ts:72），`wsClient.connect()` 在登录后调用（stores/auth.ts），前端链路本身是通的，唯独服务端不发。

### 2.3 其他必须一并修的问题

| # | 问题 | 位置 | 后果 |
| --- | --- | --- | --- |
| B1 | 审批请求不广播 | session-manager.ts:237-250 | 无入口（主 bug） |
| B2 | 遮罩点击 = dismiss，只从 store 删除不 resolve | AppShell.tsx:79、ApprovalDialog.tsx:28 | 关掉后再也回不来，服务端永久挂起 |
| B3 | REST `PendingApproval` 字段名 `id` vs Web `approvalId`；无 `args` | routes/approvals.ts:20、client.ts:231 | 即使轮询也渲染不出 |
| B4 | 刷新/重连后不恢复待审批（无 replay / 无 REST 拉取） | hub.subscribe、useWebSocket | 用户刷新一次审批就丢 |
| B5 | 无超时、无取消：中断 turn/关会话时 pending 处理不完整 | session-manager.ts:279 | 前端残留僵尸卡片 |
| B6 | WS 路径 `approval.resolve` 不做会话归属校验 | hub.ts:175-181 | 多租户下可越权批准（§14） |
| B7 | 弹窗全英文，与产品中文界面不一致 | ApprovalDialog.tsx | 体验割裂 |

---

## 3. 目标与非目标

### 3.1 目标

1. **永不静默挂起**：任何需要人工决策的调用，必须在 UI 有明确、可达、可操作的入口；刷新/重连/切会话都能恢复。
2. **就地决策**：审批入口出现在「等待中的工具调用」旁边，用户无需离开上下文；同时提供跨会话的全局待办视角。
3. **三级模式**：`询问审批 / 自动审批 / 完全访问` 语义清晰、可持久化、服务端强制生效；模式切换有明确反馈，危险模式有二次确认与常驻标识。
4. **自动审批可解释、可审计、失败关闭**：自动放行必须给出规则依据并落事件；无法判定的一律询问；高风险硬规则永不自动放行（`full` 除外）。
5. **与 CLI 语义一致**：Web 与 CLI（packages/cli/src/cli/approval.tsx 的 `y/a/n`）共享同一套 core 决策模型。

### 3.2 非目标（本期不做）

- 多人协同审批 / 审批人指派 / 审批流引擎（沿用 tenant 隔离 + 单用户）。
- 基于 LLM 的语义风险评审（作为 P3 可选增强，见 §7.7）。
- 「执行前编辑命令/参数再放行」的完整实现（协议预留，UI 放 P2）。
- 移动端适配、审批的邮件/IM 推送。
- 在 `full` 模式下提供硬性技术沙箱（依赖宿主机 sandbox；本期只做 UI 警示与事件审计）。

---

## 4. 术语与审批状态机

| 术语 | 含义 |
| --- | --- |
| Approval（审批） | 一次工具调用因命中「需人工」规则而发起的决策请求 |
| Permission Mode（权限模式） | 会话级策略档位：`ask` / `auto` / `full` |
| Decision（决策） | 引擎对一次调用的判定：`allow` / `ask` / `deny` |
| Resolution（裁决） | 人对一次 `ask` 的回应：允许一次 / 本会话允许 / 始终允许 / 拒绝 |
| Rule（规则） | 自动审批的确定性判断单元，命中后记录 `ruleId` 供审计 |
| Pending | 已发起、等待人裁决的审批项 |
| Auto-approve budget | 每轮允许自动放行的次数上限（熔断） |

### 4.1 审批项状态机

```text
                    engine.decision === 'ask'
        ┌──────────────────────────────────────────┐
        ▼                                          │
   ┌─────────┐  resolve(once/session/always)  ┌───────────┐
   │ pending │ ─────────────────────────────► │ approved  │
   └─────────┘                                └───────────┘
        │  resolve(deny / deny_and_stop)       ┌───────────┐
        ├─────────────────────────────────────►│  denied   │
        │                                       └───────────┘
        │  turn interrupted / session closed   ┌───────────┐
        ├─────────────────────────────────────►│ cancelled │
        │  timeout                             ┌───────────┐
        └─────────────────────────────────────►│  expired  │（终态=denied，fail-closed）
```

约束：

- `pending` 是**唯一**可接受 `approval.resolve` 的状态；重复 resolve 幂等返回 `false`。
- 所有非 `pending` 终态都必须回传一次 `approval.resolved` / `approval.cancelled`，前端据此清理队列。
- `deny_and_stop` 除了拒绝本次调用，还要中断当前 turn（等价于用户点「停止」后再拒绝）。

---

## 5. 竞品参考与模式取舍

| 产品 | 模式/机制 | 可借鉴点 | 取舍 |
| --- | --- | --- | --- |
| **OpenAI Codex CLI** | approval mode（`suggest` / `auto-edit` / `full-auto`）× sandbox（`read-only` / `workspace-write` / `danger-full-access`）；会话可切换 | 把「是否询问」与「能碰到什么」分开；`workspace-write` 边界清晰 | **采用**：三级模式语义与之对齐；`auto` = 自动审批 + 工作区边界 |
| **Claude Code** | `default / acceptEdits / plan / bypassPermissions`；settings 里 `permissions.allow / deny / additionalDirectories`；命令前缀匹配 | allow/deny 规则可配置、可审计；危险模式显式命名 | **采用**：学习型白名单 + 设置页规则编辑 + 危险模式二次确认 |
| **Cursor** | 终端命令 Allow/Deny；auto-run 有 allowlist/denylist；可「Allow once / Allow this command / Deny」；编辑类展示 diff | 就地决策条 + 记住单条命令 | **采用**：内联审批卡 + 「始终允许此命令」；diff 预览列为 P2 |
| **OpenHands** | Confirmation Mode：`Always Confirm / Never Confirm / Confirm Risky`，配套 SecurityAnalyzer（规则 + 可选 LLM）给出 LOW/MEDIUM/HIGH | 「只在有风险时问」的工程化实现；风险分级 | **采用**：确定性规则优先，LLM 评审为 P3 可选 |
| **Gemini CLI / VS Code Copilot Agent** | `auto-accept edits` / Autopilot 开关 | 输入区一个小开关即可表达模式，降低认知负担 | **采用**：输入框左下角紧凑 pill |
| **Aider** | `--yes-always` 等 CLI 开关 | 非交互场景的降级 | 已有对应：`--yolo` 与 background task 的 yolo |

**结论**：三级模式采用 Codex 式语义（询问 / 自动 / 完全），自动审批采用 OpenHands 式「模式 + 确定性风险分析」，规则管理采用 Claude Code 式 allow/deny，交互形态采用 Cursor 式就地决策 + 输入区开关。

---

## 6. 三级权限模式设计

### 6.1 语义定义（与截图文案对齐）

| 模式 | 标识 | 文案（副标题） | 语义 |
| --- | --- | --- | --- |
| `ask` | 🛡 询问审批 | 执行命令、修改 Workspace 外文件或访问网络前，始终询问 | 除只读工具外一律人工确认（默认） |
| `auto` | ▶ 自动审批 | 仅在检测到潜在风险时询问 | 确定性风险引擎放行低风险；高风险/越界/未知询问 |
| `full` | ⚠ 完全访问（红） | 不再询问，可自由访问你的文件、终端和网络 | 全量放行（原 `yolo`），危险，需二次确认并常驻警示 |

### 6.2 当前 core 模型与差距

现状 `PermissionSettings` 只有 `shellMode: 'ask' | 'allowlist' | 'yolo'` 与 `shellAllowlist`（packages/core/src/core/permission.ts:20-31），且 `autoApprove`（同文件 94-111）对 `read`/`net` 无条件放行、`write` 无条件询问、`danger` 按 shellMode。差距：

1. 没有 `auto`（风险驱动）档位；
2. 模式是**全局静态**的：`SessionManager.getOrCreate` 用 `this.deps.permission` 创建一次权限管理器（session-manager.ts:252-255），无法按会话切换；
3. 模式无法持久化、无法在 Web 切换。

### 6.3 目标模型

在 core 引入规范的 `PermissionMode`，并把 shell 策略降级为派生值：

```ts
// packages/core/src/core/permission.ts
export type PermissionMode = 'ask' | 'auto' | 'full';

/** shell 专用策略：保留 allowlist 以兼容 CLI 的严格白名单用法 */
export type ShellMode = 'ask' | 'allowlist' | 'auto' | 'yolo';

export interface AllowRule {
  id: string;
  /** exact：完全匹配整条命令；prefix：整词前缀匹配（"npm test" 放行 "npm test -- foo"）；tool：按工具名 */
  kind: 'exact' | 'prefix' | 'tool';
  value: string;
  /** 规则来源，便于设置页展示与撤销 */
  source: 'user' | 'session' | 'learned' | 'config';
  createdAt: string;
}

export interface PermissionSettings {
  mode: PermissionMode;
  /** 兼容旧字段：未显式给 mode 时由 mode 推导；显式配置时优先 */
  shellMode?: ShellMode;
  /** 自动放行规则（原 shellAllowlist 的超集） */
  allowlist: AllowRule[];
  /** 永远询问/拒绝的规则，优先级高于 allowlist */
  denylist: AllowRule[];
  /** auto 模式的细分开关 */
  auto: {
    /** 工作区内写入自动放行 */
    writesInWorkspace: boolean;
    /** 网络读工具（web_fetch/web_search）自动放行 */
    networkReads: boolean;
    /** 工作区内包管理器脚本（npm test / build 等）自动放行 */
    packageScripts: boolean;
    /** 每轮自动放行次数上限（熔断），默认 20 */
    budgetPerTurn: number;
  };
  /** 工作区外访问策略 */
  outsideWorkspace: 'ask' | 'deny';
  /** 等待超时（ms），0 = 不超时；超时按 fail-closed 拒绝 */
  approvalTimeoutMs: number;
}
```

旧字段兼容映射：

| 旧 `shellMode` | 新 `mode` | 说明 |
| --- | --- | --- |
| `ask` | `ask` | 不变 |
| `allowlist` | `ask` + `allowlist` 生效 | 白名单内不询问，其余询问（行为等价） |
| `auto`（新增） | `auto` | 风险引擎 |
| `yolo` | `full` | 全放行 |

### 6.4 模式 × 风险决策矩阵

`decision = allow / ask`；`full` 对 `deny` 规则也放行（但仍记录事件与警示）。

| 调用类型 | `ask` | `auto` | `full` |
| --- | --- | --- | --- |
| `read`：read_file / list_dir（工作区内） | allow | allow | allow |
| `net`：web_fetch / web_search | **ask** | allow（可配） | allow |
| `write`：write_file 工作区内 | ask | allow | allow |
| `write`：write_file 工作区外 / 敏感目录 | ask | ask（高） | allow |
| shell：只读命令 | ask | allow | allow |
| shell：工作区内变更 / 测试 | ask | allow（脚本存在时；受预算限制） | allow |
| shell：高风险（硬拒绝表） | ask（高） | ask（高，永不自动） | allow + 警示 |
| shell：无法判定 / 动态执行 | ask | ask（fail-closed） | allow |
| MCP / 未知工具 | ask | ask | allow |

> 兼容性提示：现状 `ask` 模式对 `net` 是自动放行的（permission.ts:101），而截图文案明确要求「访问网络前始终询问」。本设计按文案执行（`ask` 门控网络），并通过 `auto.networkReads` 保留宽松选项；CLI 旧配置的实际行为见 §15。

### 6.5 模式作用域与优先级

```text
会话级 permissionMode（sessions.permission_mode，NULL = 继承）
        │ 未设置
        ▼
工作区级默认（workspaces.default_permission_mode，NULL = 继承）
        │ 未设置
        ▼
全局默认（ServerConfig.permission.mode，默认 ask）
```

- 新建会话默认继承；
- 用户在输入框切换模式 → 写**会话级**（PATCH /sessions/:id）；
- 设置页可改工作区默认与全局默认；
- 运行中切换模式：仅影响**之后**发起的调用；已 `pending` 的审批不被撤销。

### 6.6 服务端生效方式（关键改造）

问题：权限管理器在 `getOrCreate` 里创建一次并捕获 `deps.permission`。目标：会话模式可变。

推荐做法（改动最小、无缓存失效问题）：让 `createInteractivePermission` 接收策略，并增加 `setMode`。

```ts
// core/permission.ts
export interface PermissionManager {
  request(tool: Tool, args: Record<string, unknown>, callId: string): Promise<PermissionDecision>;
  /** 运行期切换模式；不打断在途调用 */
  setMode(mode: PermissionMode): void;
  /** 每轮开始调用，重置自动放行预算 */
  beginTurn(): void;
  /** 本会话学习到的规则快照（供前端展示「本会话已允许」） */
  listSessionRules(): AllowRule[];
}

export function createInteractivePermission(
  ask: ApprovalAsk,
  initial: ResolvedPermissionPolicy,   // 由 resolvePermissionPolicy() 解析后的策略
): PermissionManager { /* …内部持有 current settings，可 setMode… */ }
```

`SessionManager`：

```ts
// session-manager.ts getOrCreate 内
const resolvePolicy = async (): Promise<ResolvedPermissionPolicy> =>
  resolvePermissionPolicy(session, this.deps.permission, this.deps.workspaceStore);

const permission = createInteractivePermission(
  withApprovalEvents(serverAsk, sink),
  await resolvePolicy(),
);
// 模式变更（PATCH /sessions/:id { permissionMode }）时：
//   permission.setMode(next)  —— 不需要驱逐 loop、不打断在途 turn
```

若不想引入 setMode，次优方案：模式变更时 `invalidateSession(sessionId)`（现有方法，遇 running 会拒绝），下一条消息重建 loop 时读取新模式。缺点是运行中切换延迟到下一轮，可接受。

---

## 7. 自动审批（Auto）风险引擎设计

> 目标：`auto` 模式下「只在检测到潜在风险时询问」，且每个自动决策都能解释、能审计、可关闭、失败关闭。

### 7.1 总体架构

```text
permission.request(tool, args)
        │
        ▼
┌─────────────────────────────┐
│ 1. 会话学习规则（最高优先）   │  allowlist / denylist / session rules
└─────────────────────────────┘
        │ 未命中
        ▼
┌─────────────────────────────┐
│ 2. 模式闸门                 │  ask/full 直接给结论；auto 进入 3
└─────────────────────────────┘
        │ auto
        ▼
┌─────────────────────────────┐
│ 3. 风险评估 assess()        │  工具风险 × 路径边界 × shell 分段分析
│    输出 RiskAssessment      │  { level, decision, reasons[], ruleIds[] }
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│ 4. 预算熔断                 │  auto 放行次数超限 → 升级为 ask
└─────────────────────────────┘
        │
        ▼
   allow / ask（落事件 + 给前端原因）
```

### 7.2 核心类型

```ts
// packages/core/src/core/permission-risk.ts（新增）
export type RiskLevel = 'none' | 'low' | 'medium' | 'high';

export interface RiskAssessment {
  level: RiskLevel;
  decision: 'allow' | 'ask' | 'deny';
  /** 供审批卡展示「为什么需要你确认」 */
  reasons: string[];
  /** 命中的规则 id，供审计与设置页显示 */
  ruleIds: string[];
  /** 由引擎自动得出（true）还是必须人工（false） */
  automatic: boolean;
}

export interface AssessContext {
  cwd: string;                 // 会话工作目录（workspace root）
  mode: PermissionMode;
  settings: PermissionSettings;
  sessionRules: AllowRule[];
}

export function assessToolCall(
  tool: { name: string; risk: 'read' | 'write' | 'net' | 'danger' },
  args: Record<string, unknown>,
  ctx: AssessContext,
): RiskAssessment;
```

### 7.3 判定顺序（伪代码）

```ts
function assessToolCall(tool, args, ctx): RiskAssessment {
  // ① denylist 永远优先
  const denied = matchRules(tool, args, ctx.settings.denylist);
  if (denied) return { level: 'high', decision: 'ask', automatic: false,
                       reasons: ['命中禁用规则'], ruleIds: [denied.id] };

  // ② 学习/配置白名单
  const allowed = matchRules(tool, args, [...ctx.settings.allowlist, ...ctx.sessionRules]);
  if (allowed) return { level: 'low', decision: 'allow', automatic: true,
                        reasons: ['命中已允许规则'], ruleIds: [allowed.id] };

  // ③ 模式闸门
  if (ctx.mode === 'full') return { level: 'none', decision: 'allow', automatic: true,
                                    reasons: ['完全访问模式'], ruleIds: ['mode-full'] };
  if (ctx.mode === 'ask') {
    if (tool.risk === 'read') return auto('只读工具');
    return { level: tool.risk === 'danger' ? 'high' : 'medium', decision: 'ask',
             automatic: false, reasons: ['询问审批模式'], ruleIds: ['mode-ask'] };
  }

  // ④ auto：按工具风险分派
  switch (tool.risk) {
    case 'read': return auto('只读工具');
    case 'net':  return ctx.settings.auto.networkReads
                   ? auto('网络只读工具')
                   : { level: 'medium', decision: 'ask', automatic: false,
                       reasons: ['网络访问'], ruleIds: ['net-gated'] };
    case 'write': return assessWrite(args, ctx);
    case 'danger': return assessShell(args, ctx);
  }
}
```

### 7.4 工作区边界（write / 路径类）

```ts
function assessWrite(args, ctx): RiskAssessment {
  const target = path.resolve(ctx.cwd, String(args.path ?? ''));
  const real = safeRealpath(target);              // 解析 symlink，失败则按 target
  if (isSensitiveRoot(real))                      // ~/.ssh、~/.aws、~/.gnupg、/etc、~/.config/gh…
    return ask('写入敏感目录', 'high', 'sensitive-root');
  if (!isInside(ctx.cwd, real))
    return ctx.settings.outsideWorkspace === 'deny'
      ? deny('写入工作区外', 'high', 'outside-workspace')
      : ask('写入工作区外', 'high', 'outside-workspace');
  return auto('工作区内写入');                      // 仍受预算限制
}
```

`isInside` 必须用 `path.relative(root, real)` 判断（不以 `/` 开头且不以 `..` 开头），并对 symlink 逃逸、`..` 穿越、大小写（macOS）做防御；解析失败一律 `ask`。

### 7.5 shell 命令分析（重点）

`danger` 工具（`shell`）是风险最高的入口，采用**分段 + 分类 + 保守回退**：

```ts
interface ShellSegment {
  raw: string;
  argv: string[];                 // 简易分词结果
  redirections: { op: '>' | '>>' | '<'; target: string }[];
  dynamic: boolean;               // 含命令替换、反引号、${ }、eval 等动态结构
}

function assessShell(args, ctx): RiskAssessment {
  const command = String(args.command ?? '');
  const parsed = splitShellSegments(command);      // 按 ; && || | 分段；无法可靠解析 → dynamic
  if (parsed.dynamic) return ask('命令包含动态执行结构', 'high', 'shell-dynamic');

  const reasons: string[] = []; const ruleIds: string[] = [];
  let worst: RiskLevel = 'none';

  for (const seg of parsed.segments) {
    const cls = classifySegment(seg, ctx);
    if (cls.decision === 'ask' || cls.decision === 'deny') {
      reasons.push(...cls.reasons); ruleIds.push(...cls.ruleIds);
      worst = maxRisk(worst, cls.level);
      if (cls.level === 'high') return { level: 'high', decision: 'ask', automatic: false, reasons, ruleIds };
    }
  }
  // 重定向目标越界
  for (const r of parsed.redirections) {
    if (r.op === '>') {
      const target = path.resolve(ctx.cwd, r.target);
      if (!isInside(ctx.cwd, target)) return ask('重定向写入工作区外', 'high', 'redirect-outside');
    }
  }
  if (worst === 'medium' && !ctx.settings.auto.packageScripts && isPackageScript(parsed))
    return ask('执行工作区脚本', 'medium', 'package-script');

  return auto(reasons.length ? reasons : ['低风险命令']);
}
```

**分类优先级**：硬拒绝（high，永不自动）→ 敏感读取（medium）→ 只读安全（low/allow）→ 工作区内变更（medium/allow，受预算）→ 未知（ask）。

完整规则表见 **附录 A**。要点：

- 只读安全命令逐段判定；**任一段**命中高危即整体 `ask`；
- 包管理器脚本仅当脚本确实存在于工作区 `package.json` 中才视为低风险（否则 `ask`）；
- `env` / `printenv` / 读取 `.env*` 视为 medium（可能泄露密钥）→ `ask`；
- 网络用管道进 shell（`curl … | sh`）为 high，永不自动。

### 7.6 学习型白名单与预算熔断

**学习**：

| 用户在审批卡的选择 | 产生规则 | 作用域 |
| --- | --- | --- |
| 允许一次 | 无 | — |
| 本会话允许此工具（如 write_file） | `{kind:'tool', value: toolName}` | session |
| 始终允许此命令 | `{kind:'exact', value: normalize(command)}` | 持久（设置页可删） |
| 拒绝 | 无（可选：本次 turn 内相同调用直接拒绝） | — |

规则规范化：折叠空白、去首尾空格；**不自动生成 prefix 规则**（避免 `rm` 前缀把 `rm -rf /` 也放行）；prefix 规则只能由用户在设置页手动创建。

**预算熔断**：`auto.budgetPerTurn`（默认 20）。`PermissionManager` 每轮 `beginTurn()` 清零；auto 放行计数超限后，后续 low/medium 一律 `ask`，并在审批卡上标注「本轮自动放行已达上限」。这是防止模型陷入循环、连续执行工作区变更的最后一道闸。

### 7.7 可选增强（P3）

- **LLM 风险评审**：仅对规则无法归类的 shell 命令，调用小模型做一次「这条命令会做什么、是否可逆」判断，作为 second opinion；模型只能把 `allow` 降级为 `ask`，**永远不能升级为 allow**（安全单向门）。
- **可逆性/撤销**：结合现有 checkpoint（core/checkpoint.ts）对自动放行的写操作提供「一键撤销最近 N 次自动变更」。
- **diff 预览**：写文件审批卡展示 patch（仅工作区内文本文件，且做密钥脱敏）。

---

## 8. 端到端流程与时序

### 8.1 正常审批（修复后）

```text
AgentLoop        PermissionManager      SessionManager        WS Hub          Browser
   │  request() ─────►│                     │                  │               │
   │                  │ assess → ask        │                  │               │
   │                  │ ask(request) ──────►│                  │               │
   │                  │                     │ 创建 Pending     │               │
   │                  │                     │ broadcast ──────►│ approval.request ─►│ 入队
   │                  │                     │ sink(approval_request 事件) ──► 工具卡显示 waiting
   │（挂起）           │                     │                  │               │
   │                  │◄──── resolve ◄──────┤◄─ approval.resolve┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄│ 用户点「允许」
   │                  │ 返回 decision       │ 删除 pending     │               │
   │◄─ 继续执行        │                     │ broadcast(resolved) ─────────────►│ 出队
```

### 8.2 刷新 / 断线重连恢复

1. 连接建立或重连后，前端对当前会话 `subscribe`；
2. Hub 在 `subscribe(ws, sessionId)` 内主动推送该会话所有 pending（`replayed: true`）；
3. 前端同时用 REST `GET /sessions/:id/approvals/pending` 兜底（WS 与 REST 双通道，幂等去重）；
4. 会话切换时按 sessionId 过滤显示。

### 8.3 取消 / 中断

- 用户点「停止」或 `POST /sessions/:id/interrupt` → `cancelPendingForSession` 把所有 pending 置为 `cancelled`，resolve `'no'`，并 `broadcastApprovalCancelled`；
- 关闭/删除会话同理；
- 超时：`approvalTimeoutMs > 0` 时定时器到期 → `expired`（等同 deny），广播 `approval.resolved`（`source:'timeout'`）。

### 8.4 多标签页

- 所有订阅同一会话的标签页都会收到 `approval.request`；任一标签页裁决后服务端广播 `approval.resolved`，其他标签页出队并提示「已由其他窗口处理」；
- 重复 resolve 服务端幂等。

---

## 9. 协议与服务端设计

### 9.1 WebSocket 协议（packages/server/src/ws/protocol.ts）

**server → client**

```ts
// 扩展 approval.request（保留旧字段，纯新增）
{
  type: 'approval.request';
  approvalId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  summary: string;
  risk: { level: 'none'|'low'|'medium'|'high'; reasons: string[]; ruleIds: string[] };
  options: Array<'once'|'session'|'always'|'deny'|'deny_and_stop'>;
  createdAt: string;
  expiresAt?: string;
  queuePosition: number;     // 同会话队列中的位置
  replayed?: boolean;        // 重连/刷新补发
}

// 新增
{ type: 'approval.resolved'; approvalId: string; sessionId: string; approved: boolean;
  resolution: 'once'|'session'|'always'|'deny'|'deny_and_stop';
  source: 'user'|'timeout'|'system'; resolvedBy?: string }
{ type: 'approval.cancelled'; approvalId: string; sessionId: string; reason: string }
```

**client → server**

```ts
// 扩展 approval.resolve（兼容旧 { approved, scope }）
{ type: 'approval.resolve'; approvalId: string;
  resolution?: 'once'|'session'|'always'|'deny'|'deny_and_stop';
  approved?: boolean; scope?: 'once'|'session';   // 旧字段，仍接受
  args?: Record<string, unknown>;                 // P2：编辑后执行
}
```

### 9.2 Hub 改造（packages/server/src/ws/hub.ts）

```ts
subscribe(ws, sessionId) {
  /* …现有逻辑… */
  // ★ 重放该会话未决审批，修复刷新/重连丢失（B4）
  for (const a of this.deps.sessionManager.getPendingApprovals(sessionId)) {
    this.sendApprovalRequest(ws, sessionId, a, /* replayed */ true);
  }
}

broadcastApprovalRequest(sessionId, approval) { /* 现有实现，改为调用 sendApprovalRequest */ }
broadcastApprovalResolved(sessionId, approvalId, resolution, source) { /* 新增 */ }
broadcastApprovalCancelled(sessionId, approvalId, reason) { /* 新增 */ }
```

### 9.3 SessionManager 改造（packages/server/src/session-manager.ts）

```ts
const serverAsk = async (request: ApprovalRequest): Promise<ApprovalAnswer> => {
  const approvalId = randomUUID();
  const deferred = new DeferredImpl<ApprovalAnswer>();
  const assessment = request.risk;                 // 由 withApprovalEvents 透传（见 §13）
  const approval: PendingApproval = {
    id: approvalId, sessionId, callId: request.callId,
    toolName: request.toolName, summary: request.summary,
    risk: assessment?.level, reasons: assessment?.reasons,
    createdAt: new Date().toISOString(),
    ...(this.deps.permission.approvalTimeoutMs > 0
      ? { expiresAt: new Date(Date.now() + this.deps.permission.approvalTimeoutMs).toISOString() }
      : {}),
  };
  this.pendingApprovals.set(approvalId, { approval, resolve: deferred.resolve.bind(deferred) });

  // ★★ 修复 B1：推送给订阅该会话的客户端
  this.deps.wsHub?.broadcastApprovalRequest(sessionId, approval);

  // 超时 fail-closed
  if (approval.expiresAt) {
    setTimeout(() => {
      if (this.pendingApprovals.delete(approvalId)) {
        deferred.resolve('no');
        this.deps.wsHub?.broadcastApprovalResolved(sessionId, approvalId, 'deny', 'timeout');
      }
    }, this.deps.permission.approvalTimeoutMs).unref?.();
  }
  return deferred.promise;
};
```

`resolveApproval` 扩展为接受 `ApprovalResolution` 并派发所有终态广播；`cancelPendingForSession` 增加 `broadcastApprovalCancelled`。

### 9.4 REST（packages/server/src/routes/approvals.ts）

统一字段（修复 B3）：

```ts
// GET /api/v1/sessions/:id/approvals/pending
{ approvals: Array<{ approvalId, sessionId, callId, toolName, summary,
                     risk?, reasons?, createdAt, expiresAt? }> }

// POST /api/v1/approvals/:id/resolve
{ resolution?: 'once'|'session'|'always'|'deny'|'deny_and_stop',
  approved?: boolean, scope?: 'once'|'session' }   // 旧字段兼容

// 新增（P1）：全局待办，供跨会话角标
GET /api/v1/approvals/pending → { approvals: [...] }
```

归属校验（修复 B6）：解析前校验该 `approvalId` 所属 `sessionId` 存在且属于当前用户/租户；WS `approval.resolve` 同样校验连接是否订阅了该会话或拥有该会话。

### 9.5 AgentLoop / core 透传

`withApprovalEvents` 与 `ApprovalRequest` 需要携带风险评估，供服务端落事件与推送：

```ts
export interface ApprovalRequest {
  callId: string;
  toolName: string;
  summary: string;
  risk?: { level: RiskLevel; reasons: string[]; ruleIds: string[] };  // 新增
}
```

---

## 10. 数据模型与迁移

### 10.1 会话权限模式

```sql
-- SQLite (packages/core/src/storage/db.ts) 与 PostgreSQL (packages/server/src/storage/schema.ts) 同步
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;            -- NULL = 继承
CREATE INDEX IF NOT EXISTS idx_sessions_permission ON sessions(permission_mode);
```

### 10.2 工作区默认模式

```sql
ALTER TABLE workspaces ADD COLUMN default_permission_mode TEXT;  -- NULL = 继承全局
```

### 10.3 领域类型（core/ports.ts）

```ts
export interface Session {
  /* … */
  permissionMode: PermissionMode | null;   // null = 继承工作区/全局
}
export interface SessionUpdate {
  /* … */
  permissionMode?: PermissionMode | null;
}
```

### 10.4 迁移策略

- SQLite / PG 用现有 schema 版本机制（见 packages/core/src/storage/db.ts、packages/server/src/storage/migrate.ts）新增一版迁移；
- 读取旧库时 `permissionMode = null`，行为回退到全局 `ServerConfig.permission`；
- 不改变现有行；纯新增列，向后兼容。

---

## 11. 前端交互设计（入口 / 组件 / 线框）

### 11.1 入口全景（需求 1）

审批必须有**多级可达入口**，核心原则：**主入口在等待点旁边，兜底入口永远在视口内，跨会话入口可见**。

| 优先级 | 入口 | 位置 | 场景 |
| --- | --- | --- | --- |
| P0 | **内联审批卡** | 对话流中等待中的 tool step 内（ToolSteps） | 用户正看着上下文 |
| P0 | **待办条** | 输入框正上方，常驻 | 工具卡被折叠/滚出视口 |
| P1 | **顶栏角标** | HeaderBar 右侧 🛡 数字 | 有任意待审批 |
| P1 | **会话项标记** | 侧栏 SessionItem 上的黄点 + 数字 | 待审批在别的会话 |
| P2 | **系统通知** | Notification API + 标签页标题闪动 | 标签页在后台 |
| P2 | **设置页** | 设置 → 权限 | 规则管理/审计 |

**同一时刻最多一个聚焦弹窗**，其余以队列形式（「1 / 3」）串行展示，避免模态叠加。

### 11.2 主入口：内联审批卡

在 `ToolStepItem`（packages/web/src/components/Chat/ToolSteps.tsx:57-85）中，将现有只读的 `tool-step__waiting` 升级为可交互卡片：

```text
┌───────────────────────────────────────────────────────────────┐
│ 🔧 write_file                                         ⏳ 待确认   │
│    path: notes/user.md                                         │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │  需要你的确认                                                │ │
│ │  写入文件 notes/user.md（23 字符）                            │ │
│ │  风险：低 · 命中规则：工作区内写入                              │ │
│ │                                                            │ │
│ │  [ 允许一次 ]  [ 本会话允许 write_file ]   [ 始终允许 ]  [ 拒绝 ] │ │
│ └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

- 通过 `callId` 把 `toolStep` 与 `pendingApproval` 关联：`turn-grouping.ts` 的 `ToolStep.waitingApproval`（当前只有 `summary`）扩展为携带 `approvalId`（见 §13 事件扩展）或由 store 按 `callId` 反查；
- shell 命令类：展示命令本身 + 风险原因（「包含递归删除」「写入工作区外」）；
- `拒绝` 与 `拒绝并停止` 在下拉里合并，主按钮为「拒绝」；
- 就地操作后卡片进入 `resolving` 态，收到 `approval.resolved` 后替换为执行结果。

### 11.3 兜底入口：输入框上方待办条

```text
┌───────────────────────────────────────────────────────────────┐
│ ⚠ 有 1 个操作等待你的确认  ·  write_file notes/user.md   [ 处理 ] │
└───────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────┐
│ 📎 🎤  [🛡 询问审批 ⌄]                              模型 ▾   ↑  │
└───────────────────────────────────────────────────────────────┘
```

- 只要有 pending 就常驻，保证任何滚动位置都能触达；
- 点击 `处理` → 滚动到对应工具卡并聚焦，或打开聚焦弹窗。

### 11.4 跨会话：顶栏角标 + 侧栏标记

```text
HeaderBar:   …   [🛡 2]   🌙
侧栏:        ▸ 修复登录 bug        🟡2
             ▸ 重构上下文管理
```

点击角标/标记 → 切换到该会话并打开其待办条。

### 11.5 输入框三级模式选择器（需求 2）

位置：输入框左下角，紧邻附件按钮（截图中的 `自动审批 ⌄`），实现为紧凑 pill + 下拉。当前 composer（ChatArea.tsx:243-248）左侧已有 `PaperClipIcon` / `MicrophoneIcon`，在其后插入 `<PermissionModeSelector />`。

```text
折叠态：  [ 🛡 询问审批 ⌄ ]

展开态：
┌─────────────────────────────────────────────────────────────┐
│ 🛡  询问审批                                                  │
│     执行命令、修改 Workspace 外文件或访问网络前，始终询问          │
│                                                             │
│ ▶   自动审批                                              ✓  │
│     仅在检测到潜在风险时询问                                    │
│                                                             │
│ ⚠   完全访问                                          （红）   │
│     不再询问，可自由访问你的文件、终端和网络                       │
└─────────────────────────────────────────────────────────────┘
```

交互规格：

| 行为 | 规格 |
| --- | --- |
| 切换 | 立即 PATCH 到会话；toast「已切换为 自动审批」 |
| 切到 `full` | 弹二次确认：「完全访问将不再询问，Agent 可读写任意文件、执行任意命令。确认开启？」 |
| `full` 生效中 | pill 变红并常驻，输入框加红色描边，状态栏显示「完全访问」警示 |
| 键盘 | `⌘/Ctrl + .` 循环切换；下拉内 ↑↓ + Enter |
| 无会话 | 禁用，提示先创建会话 |
| 不可用项 | `auto` 若被管理员关闭（config），显示为禁用并给出原因 |
| 状态来源 | 会话 `permissionMode`（NULL 时显示继承值，并以「继承」弱化标识） |

### 11.6 组件清单（新增/改造）

| 组件 | 路径 | 说明 |
| --- | --- | --- |
| `PermissionModeSelector` | components/Permissions/PermissionModeSelector.tsx | 输入框 pill + 下拉；新增 |
| `PermissionModeConfirm` | components/Permissions/PermissionModeConfirm.tsx | 切 `full` 的二次确认；新增 |
| `ApprovalCard` | components/Approval/ApprovalCard.tsx | 内联审批卡；新增 |
| `ApprovalQueueBar` | components/Approval/ApprovalQueueBar.tsx | 输入框上方待办条；新增 |
| `ApprovalBadge` | components/Approval/ApprovalBadge.tsx | 顶栏/侧栏角标；新增 |
| `ApprovalDialog` | components/Approval/ApprovalDialog.tsx | 改造：中文、不可静默 dismiss、展示风险原因、多选项 |
| `PermissionsView` | features/settings/PermissionsView.tsx | 设置 → 权限（把 `features.permissions` 置为 live）；新增 |
| `ToolStepItem` | components/Chat/ToolSteps.tsx | 接入内联审批卡；改造 |
| `ChatArea` | components/Chat/ChatArea.tsx | 插入选择器与待办条；改造 |

### 11.7 可访问性

- 审批卡 `role="alertdialog"` / 待办条 `role="status" aria-live="polite"`；
- 聚焦弹窗打开时焦点陷阱 + Esc = 拒绝（对话框内二次确认，避免误触），不使用「Esc 静默关闭」；
- 所有操作按钮 `aria-label` 含工具名与路径。

---

## 12. 前端状态管理

### 12.1 approval store 重构

现状是扁平数组（packages/web/src/stores/approval.ts），需按会话分桶并区分「已解决」：

```ts
interface ApprovalState {
  byId: Record<string, ApprovalRequest>;
  bySession: Record<string, string[]>;      // sessionId → approvalId[]（有序队列）
  resolving: Record<string, boolean>;
  /** 新增/合并（WS 或 REST 补发，幂等） */
  upsert: (req: ApprovalRequest) => void;
  /** 服务端确认解决后移除 */
  settle: (approvalId: string) => void;
  clearSession: (sessionId: string) => void;
}
```

关键变更：

1. **移除只依赖本地 `removeApproval` 的语义**：只有收到 `approval.resolved` / `approval.cancelled` / REST 成功回执后才出队；
2. `settle` 与 `upsert` 幂等，天然支持多标签页与重连补发；
3. 队列顺序按 `createdAt` / 服务端 `queuePosition`。

### 12.2 连接与恢复

```ts
// useWebSocket.ts
wsClient.on('approval', (req) => addApproval(req));
wsClient.on('approvalResolved', ({ approvalId }) => settle(approvalId));
wsClient.on('approvalCancelled', ({ approvalId }) => settle(approvalId));
wsClient.on('connected', () => void rehydratePending());   // 断线重连兜底
```

`rehydratePending()`：对当前会话（P1 扩展为所有已知会话）调用 `api.sessions.approvalsPending(id)`，逐条 `upsert`。

### 12.3 解析动作

```ts
// stores/approval.ts 或 hooks/useApproval.ts
async function resolve(approvalId, resolution) {
  setResolving(approvalId, true);
  try {
    if (wsClient.isOpen()) wsClient.resolveApproval(approvalId, resolution);
    else await api.approvals.resolve(approvalId, resolution);   // WS 断线降级 REST
  } catch (e) {
    setResolving(approvalId, false);
    toast.error('审批提交失败，请重试');
  }
  // 不做乐观出队；等服务端 approval.resolved 事件
}
```

---

## 13. 事件与审计

### 13.1 事件扩展（packages/core/src/types/events.ts）

```ts
// approval_request 增加自动/人工与风险信息（纯新增可选字段，旧数据可读）
z.object({
  type: z.literal('approval_request'),
  callId: z.string(),
  toolName: z.string(),
  summary: z.string(),
  risk: z.object({ level: RiskLevelSchema, reasons: z.array(z.string()), ruleIds: z.array(z.string()) }).optional(),
})

// approval_result 增加裁决来源
z.object({
  type: z.literal('approval_result'),
  callId: z.string(),
  approved: z.boolean(),
  scope: z.enum(['once', 'session']),
  resolution: z.enum(['once','session','always','deny','deny_and_stop']).optional(),
  source: z.enum(['user', 'auto', 'timeout', 'system']).optional(),
})

// 新增：模式变更（审计「谁在何时开了完全访问」）
z.object({ type: z.literal('permission_mode_changed'),
           previous: z.enum(['ask','auto','full']),
           next: z.enum(['ask','auto','full']),
           scope: z.enum(['session','workspace','global']) })

// 可选：自动放行的可见性（让「没问你」也可审计）
z.object({ type: z.literal('tool_auto_approved'),
           callId: z.string(), toolName: z.string(), ruleIds: z.array(z.string()) })
```

### 13.2 审计要求

- **自动放行也要留痕**（`tool_auto_approved` 或 `approval_request%7Bdecision:'ask'%7D` 的对偶），用户可在设置页看到「本轮自动执行了什么」；
- `permission_mode_changed` 必须落库，尤其是 `full` 的开启/关闭；
- `approval_result.source` 区分人、超时、系统（中断）；
- 事件仍是 append-only、按 `callId` 配对，保持 replay-check（packages/core/examples/replay-check.ts）通过。

---

## 14. 安全与边界

1. **越权（B6）**：WS `approval.resolve` 与 `subscribe` 目前不校验会话归属。必须校验：连接对应的 userId / tenant 能访问该 sessionId；`resolveApproval` 之前校验 `approvalId` 属于该连接已订阅/拥有的会话。
2. **密钥不入审批载荷**：沿用现有约定（permission.ts:14-15），`summary` 只含路径/命令/大小；新增的 `risk.reasons` 同样不得包含文件内容。写操作默认不展示内容（diff 预览作为 P2 必须脱敏）。
3. **fail-closed**：无法解析、超时、UI 无应答、非交互模式（`createNonInteractivePermission`）一律拒绝；`full` 是唯一例外且必须显式开启。
4. **动态执行**：shell 含命令替换、反引号、`eval`、`exec`、`base64 -d | sh`、管道进 shell 等，auto 模式一律 `ask`。
5. **工作区边界**：symlink、`..`、大小写、`/tmp` 例外需明确；`outsideWorkspace: 'deny'` 可供强隔离部署。
6. **MCP 未知工具**：MCP adapter 目前把工具标为 `net`（packages/core/src/mcp/adapter.ts:35）。MCP 工具能力不可知，`auto` 下应默认 `ask`，除非用户按工具名显式 allowlist。
7. **完全访问警示**：`full` 生效期间 UI 常驻红色标识 + 状态栏显示，并落 `permission_mode_changed` 事件。

---

## 15. 兼容性与迁移

| 对象 | 兼容策略 |
| --- | --- |
| 配置文件 `permission.shellMode` | 保留；未给 `mode` 时按 §6.3 映射；给出 deprecation 注释 |
| CLI `--yolo` | 映射到 `mode: 'full'` |
| CLI `approval.tsx` 的 `y/a/n` | `y`→once，`a`→session，`n`→deny；共享 core 决策 |
| 非交互 `yo -p` | `createNonInteractivePermission` 行为不变（auto 引擎可用于 allow，其余拒绝） |
| background task | 维持 yolo（task-runner.ts:88），文档标注为已知风险 |
| 旧 WS 客户端 | `approval.request` 新旧字段并存；`approval.resolve` 仍接受 `{approved,scope}` |
| 旧 REST 调用 | `resolve` 仍接受 `{approved,scope}`；pending 响应新增 `approvalId` 的同时保留 `id` 一个版本 |

---

## 16. 实施路线图与文件清单

### P0 — 止血（0.5～1 天）

目标：截图场景可用，刷新不丢。

| 文件 | 改动 |
| --- | --- |
| packages/server/src/session-manager.ts | `serverAsk` 增加 `wsHub.broadcastApprovalRequest`；`cancelPendingForSession` 广播 cancelled |
| packages/server/src/ws/hub.ts | `subscribe` 内补发 pending；抽 `sendApprovalRequest` |
| packages/web/src/components/Approval/ApprovalDialog.tsx | 中文文案；遮罩点击不 dismiss（改为拒绝需显式按钮）；展示 risk reasons（若服务端已提供） |
| packages/web/src/layout/AppShell.tsx | `onDismiss` 语义修正：不再本地删除挂起项 |
| packages/web/src/stores/approval.ts | 收到 `approval.resolved/cancelled` 才出队 |
| packages/server/src/routes/approvals.ts + packages/web/src/api/client.ts | 统一 `approvalId` 字段 |
| packages/web/src/hooks/useWebSocket.ts | 重连后 REST 拉取 pending |

验收：截图场景出现可点击审批卡/弹窗；批准后 turn 继续；刷新后仍可审批；拒绝后 turn 正常结束。

### P1 — 体验（2～3 天）

- 内联审批卡（ApprovalCard + ToolSteps 改造）；
- 输入框上方待办条 + 顶栏/侧栏角标；
- 三级模式选择器 + 会话级持久化（`sessions.permission_mode` 迁移 + PATCH + 服务端 setMode）；
- `approval.resolved` / `approval.cancelled` 协议与多标签页同步；
- 通知（Notification API + 标签页标题）。

### P2 — 自动审批（3～5 天）

- core 新增 `permission-risk.ts`：规则引擎 + shell 分段分类 + 工作区边界；
- 学习型白名单 + 每轮预算熔断 + 超时 fail-closed；
- 设置 → 权限 页面（默认模式、allowlist/denylist 编辑、预算、超时、审计列表）；
- 事件扩展（`permission_mode_changed`、`tool_auto_approved`）与 replay 测试。

### P3 — 增强（可选）

- LLM 风险评审（单向门）、diff 预览、撤销最近自动变更、审批审计报表、企业策略下发。

---

## 17. 测试策略

### 17.1 core（vitest）

- **风险引擎表驱动**：附录 A 每条规则至少 1 个正/反例（`rm -rf /` → ask；`ls -la` → allow；`curl x | sh` → ask；`echo hi > /etc/hosts` → ask；`npm test` 且脚本存在 → allow）；
- shell 分段：`a && b`、`a | b`、重定向、命令替换、引号内 `;` 不误切；
- 工作区边界：`..` 穿越、symlink 逃逸、敏感目录；
- 旧 `shellMode` 兼容映射；
- 预算熔断与 `beginTurn` 重置；
- 事件配对（复用 examples/replay-check.ts）。

### 17.2 server

- `serverAsk` 触发 `broadcastApprovalRequest`（mock hub 断言）；
- `subscribe` 补发 pending（重连恢复）；
- resolve 派发 `approval.resolved`；取消/中断派发 `approval.cancelled`；
- 超时自动拒绝；
- 越权：未订阅/非归属会话 resolve → 拒绝；
- REST 字段形状与旧字段兼容。

### 17.3 web

- `ApprovalCard`：点击各按钮发送正确 resolution；
- store：upsert 幂等、settle、按会话分桶、多标签（收到 resolved 出队）；
- `PermissionModeSelector`：切换 PATCH、`full` 二次确认、快捷键、继承显示；
- `ToolSteps`：waiting 状态渲染内联审批卡；
- 现有 `ApprovalDialog.test.tsx` 更新。

### 17.4 E2E（Playwright，若已有则扩展）

- 复现截图场景 → 出现审批入口 → 允许 → 文件写入 → turn 完成；
- 刷新页面后审批入口仍在；
- 切到 `完全访问` → 不再询问（有红色警示）；
- 切到 `自动审批` → 只读命令不询问、`rm -rf` 仍询问。

---

## 18. 验收标准

| # | 需求 | 验收（可测） |
| --- | --- | --- |
| 1 | 审批入口可达 | 任何 `pending` 都能在对话内联卡、待办条、顶栏角标三者之一触达；无「无入口」状态 |
| 2 | 主 bug 修复 | 截图场景出现中文审批卡，点击「允许一次」后 `tool_result` 到达、turn 正常结束 |
| 3 | 不静默丢弃 | 关闭弹窗/切会话/刷新后，pending 仍存在且服务端未被错误 resolve |
| 4 | 三级模式 | 输入框左下角可切换三档；切 `full` 有二次确认；模式持久化到会话；服务端实际生效 |
| 5 | 自动审批 | `auto` 下只读/工作区内低风险不询问；越界、高危、未知、动态执行仍询问，并给出 reasons |
| 6 | 可审计 | 每次自动放行与模式切换都有事件；设置页可查看/删除白名单 |
| 7 | 失败关闭 | 超时/断连/无 UI 一律拒绝；`full` 是唯一例外 |
| 8 | 兼容 | 旧 `shellMode`/`--yolo`/CLI `y a n`/旧 WS 消息行为不回归 |

---

## 19. 风险与开放问题

| # | 问题 | 倾向/建议 |
| --- | --- | --- |
| Q1 | `ask` 模式是否门控网络（截图文案要求门控，现状自动放行） | 建议门控，用配置保留宽松；需产品确认 |
| Q2 | `auto` 是否为默认模式 | 建议默认 `ask`（安全），新用户引导时可推荐 `auto` |
| Q3 | 审批超时默认值 | 建议 5～10 分钟并支持「继续等待」；纯本地可设 0（不超时） |
| Q4 | 「始终允许」的持久化作用域 | 建议按工作区持久化并在设置页可见、可撤销 |
| Q5 | 是否允许编辑命令后执行 | P2；协议已预留 `args` |
| Q6 | 自动审批是否引入 LLM 评审 | P3；只允许把 allow 降级为 ask |
| Q7 | background task 的 yolo 是否收紧 | 建议后台任务默认禁止写工作区外，并与本期一并评估 |
| Q8 | 多租户审批权限 | 需明确「谁能批准」；本期先做会话归属校验 |

---

## 附录 A：自动审批风险规则表

### A.1 硬拒绝（high，auto 永不自动）

| 规则 id | 匹配 | 说明 |
| --- | --- | --- |
| `priv-escalation` | `sudo` `su` `doas` `runas` | 提权 |
| `recursive-delete` | `rm` 带 `-r`/`-f`，目标为 `/` `~` `$HOME` `*` 或工作区外 | 递归删除 |
| `disk-format` | `mkfs` `fdisk` `diskutil` `dd of=/dev/*` | 磁盘操作 |
| `system-control` | `shutdown` `reboot` `halt` `launchctl` `systemctl` `service` `crontab` `at` | 系统控制 |
| `process-kill` | `kill` `pkill` `killall` | 杀进程 |
| `perm-change-outside` | `chmod`/`chown` 递归且目标为 `/` 或工作区外 | 权限变更 |
| `git-destructive` | `git push` `git reset --hard` `git clean -fd[x]` `git rebase` `git filter-branch` | 破坏性 git |
| `publish` | `npm/pnpm/yarn publish` `pip install -g/--user` `cargo publish` | 发布/全局安装 |
| `pipe-to-shell` | `curl … \| sh`、`wget … \| bash`、`bash <(curl …)`、`base64 -d \| sh` | 远程代码执行 |
| `dynamic-exec` | `eval` `exec`、命令替换/反引号、`sh -c` 拼接 | 动态执行 |
| `sensitive-redirect` | `>`/`>>` 指向 `/dev/sd*` `/etc/*` `~/.ssh/*` `~/.aws/*` 或工作区外 | 越界写入 |
| `credential-egress` | `ssh` `scp` `rsync` 到远端，或命令包含 `.ssh/` `.aws/` `.env` 且外发 | 凭据外泄 |
| `privileged-container` | `docker run --privileged`、挂载 docker socket/`/` | 容器逃逸 |

### A.2 只读安全（low，可自动）

```text
ls pwd cd echo cat head tail wc file stat tree realpath basename dirname
grep rg ag fd jq yq cut sort uniq tr diff comm md5 shasum
sed -n（无 -i） awk（无 system/重定向）
which type command -v man help date cal uname hostname whoami id
df du ps
git status|diff|log|show|branch|remote|rev-parse|ls-files|blame
npm ls|view|outdated ; node -v ; python --version ; go version ; rustc --version
```

### A.3 敏感读取（medium → ask）

`env`、`printenv`、`cat .env*`、`cat ~/.ssh/*`、`cat ~/.aws/*`、`history`、读取工作区外的任意文件。

### A.4 工作区内变更（medium → auto，受预算）

`mkdir touch cp mv ln`（目标在工作区内）、`write_file`（工作区内）、`git add|commit|stash|switch|checkout -b`、`prettier -w`/`eslint --fix`/`gofmt -w`/`black`/`rustfmt`、`> file`/`>> file`（工作区内）、`chmod +x`（工作区内）。

### A.5 包管理器脚本

`npm/pnpm/yarn test|run <script>|build|lint|typecheck`、`make <target>`、`cargo test|build`、`go test|build`：仅当脚本/target 在工作区清单中存在时按 low/medium 自动（可配 `auto.packageScripts`），否则 `ask`。

### A.6 默认

其余一律 `ask`（fail-closed）。

---

## 附录 B：文案（中英）

| key | zh | en |
| --- | --- | --- |
| `permission.mode.ask.title` | 询问审批 | Ask before acting |
| `permission.mode.ask.desc` | 执行命令、修改 Workspace 外文件或访问网络前，始终询问 | Always ask before running commands, editing files outside the workspace, or accessing the network |
| `permission.mode.auto.title` | 自动审批 | Auto-approve |
| `permission.mode.auto.desc` | 仅在检测到潜在风险时询问 | Ask only when a potential risk is detected |
| `permission.mode.full.title` | 完全访问 | Full access |
| `permission.mode.full.desc` | 不再询问，可自由访问你的文件、终端和网络 | No prompts; unrestricted file, terminal, and network access |
| `permission.full.confirm` | 完全访问将不再询问，Agent 可读写任意文件、执行任意命令。确认开启？ | Full access disables all prompts. Continue? |
| `approval.card.title` | 需要你的确认 | Approval required |
| `approval.action.once` | 允许一次 | Allow once |
| `approval.action.session` | 本会话允许 {tool} | Allow {tool} this session |
| `approval.action.always` | 始终允许此命令 | Always allow this command |
| `approval.action.deny` | 拒绝 | Deny |
| `approval.action.denyStop` | 拒绝并停止 | Deny and stop |
| `approval.bar.pending` | 有 {n} 个操作等待你的确认 | {n} action(s) awaiting your confirmation |
| `approval.busy` | 正在提交… | Submitting… |
| `approval.resolvedByOther` | 已由其他窗口处理 | Handled in another window |

---

## 附录 C：参考链接

- OpenAI Codex CLI（approval modes × sandbox）：https://github.com/openai/codex
- Claude Code 权限与规则（allow/deny/settings）：https://docs.claude.com/en/docs/claude-code/iam
- Cursor Agent 终端与 auto-run：https://docs.cursor.com/
- OpenHands Confirmation Mode / SecurityAnalyzer：https://github.com/All-Hands-AI/OpenHands
- Gemini CLI auto-accept：https://github.com/google-gemini/gemini-cli
- VS Code Copilot Agent Mode：https://code.visualstudio.com/docs/copilot/chat/chat-agent-mode

> 注：外部链接请在评审时复核最新路径。
