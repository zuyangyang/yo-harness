/**
 * Agent 主循环（§6.7）：把 LLM、工具、权限、预算、上下文、事件流串成回路。
 *
 * runTurn：turn_started → 预算启动 → user_input 落库 → 循环
 * { 熔断检查 → 上下文构建（发生裁剪则落 context_elided）→ LLM 调用 →
 *   assistant_text 落库 → 无 toolCalls 即 done；否则逐个 tool_call 落库
 *   → 权限审批 → 执行 → tool_result 落库 } → finally 落 turn_completed。
 *
 * 中断语义：interrupt() 只置标志，循环在"当前工具结束后、下一次 LLM
 * 调用前"检查 —— 工具消息必须成组应答，半途弃答会产生游离 tool 消息，
 * 违反 Provider 消息结构约束。
 *
 * 错误分级：LLM 失败包成 LlmStageError（error 事件 stage='llm'），其余
 * 记 stage='loop'；原始错误是 TransientError 时标记 recoverable。工具
 * run() 违约 throw 不拖垮回合，降级为 ok=false 的 tool_result。
 *
 * 循环只依赖端口（LLMClient / EventStore / ToolResolver /
 * PermissionManager / TurnBudget / ContextManager），装配在 CLI 层完成。
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from '../types/common.js';
import type {
  AgentEvent,
  EventEnvelope,
  ToolCall,
  TurnEndReason,
  Usage,
} from '../types/events.js';
import { BudgetStop, isTransientError, TransientError } from '../types/errors.js';
import type { ChatMessage, ChatRequest, ChatResponse, LLMClient } from '../types/llm.js';
import type { ToolResult } from '../types/tools.js';
import type { SandboxProvider } from '../types/sandbox.js';
import { TokenCalibrator } from '../utils/tokens.js';
import type { TurnBudget } from './budget.js';
import type { ContextBuildResult, ContextManager } from './context-manager.js';
import type { EventBus } from './event-bus.js';
import type { EventStore, ToolResolver } from './ports.js';
import type { PermissionManager } from './permission.js';
import type { ModelRouter } from '../router/model-router.js';
import type { CostTracker } from '../router/cost-tracker.js';
import { lookupPrice } from '../llm/pricing.js';
import type { ModelPrice, PricingTable } from '../types/pricing.js';

export interface AgentLoopDeps {
  sessionId: string;
  /** 会话工作目录，工具执行的相对路径基准 */
  cwd: string;
  router: ModelRouter;
  costTracker: CostTracker;
  store: EventStore;
  tools: ToolResolver;
  permission: PermissionManager;
  budget: TurnBudget;
  context: ContextManager;
  bus: EventBus;
  systemPrompt: string;
  maxTokens: number;
  temperature?: number;
  logger: Logger;
  /** Phase 4：沙箱提供者 */
  sandbox: SandboxProvider;
  /**
   * 写前快照回调；undefined = 禁用（测试 / 无检查点场景）。
   * relPath 相对 cwd，seq 为触发写的 tool_call 事件序号。
   */
  checkpoint?: {
    snapshotBeforeWrite: (relPath: string, seq: number) => Promise<string>;
  };
  /**
   * 目标追踪 hook；undefined = 禁用。
   * initialize 在每轮开始时用用户输入初始化目标，
   * checkDrift 每步调用检测漂移，systemPromptInjection 拼进 system prompt。
   */
  goalTracker?: {
    initialize(userInput: string): void;
    checkDrift(currentStep: number, recentToolCalls: ToolCall[]): string | undefined;
    toSystemPromptInjection(): string | undefined;
  };
  /** 模型价格表（成本核算）；undefined = 不核算成本，仅累计 token */
  pricing?: PricingTable;
  /** 工具 schema 下发模式（§9.3）；默认 full，compact 裁到顶层属性名 */
  toolsSchemaMode?: 'full' | 'compact';
  /** 逐模型 token 估算校准器（§10.1）；undefined = 不校准 */
  tokenCalibrator?: TokenCalibrator;
}

/** 连续 max_tokens 截断的续写上限，超过则按当前输出收尾，防止死循环 */
const MAX_CONTINUATIONS = 3;

/** tool_result 事件（并行执行时作为返回值收集，再按序落库） */
type ToolResultEvent = Extract<AgentEvent, { type: 'tool_result' }>;

/** LLM 阶段失败的标记：error 事件 stage='llm'，原始错误保存在 original */
class LlmStageError extends Error {
  constructor(public readonly original: unknown) {
    super(`llm chat failed: ${String(original)}`);
  }
}

/** 中断中止标记：LLM 调用被 abort，runSteps 映射为 'interrupted' */
class InterruptedError extends Error {
  constructor() {
    super('llm chat interrupted');
  }
}

export class AgentLoop {
  private interruptFlag = false;
  private turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };
  private truncationCount = 0;
  private recentToolCalls: ToolCall[] = [];
  private turnAbort: AbortController | undefined;

  constructor(private readonly deps: AgentLoopDeps) {}

  /** 暴露上下文管理器：resume 重建 / CLI 检查用 */
  get context(): ContextManager {
    return this.deps.context;
  }

  /** 请求中断：中止当前 LLM 流式调用；工具执行结束后、下一次 LLM 调用前生效 */
  interrupt(): void {
    this.interruptFlag = true;
    this.turnAbort?.abort();
  }

  async runTurn(userText: string): Promise<TurnEndReason> {
    const turnId = randomUUID();
    this.interruptFlag = false;
    this.turnUsage = { inputTokens: 0, outputTokens: 0 };
    this.truncationCount = 0;
    this.recentToolCalls = [];
    this.turnAbort = new AbortController();
    this.deps.goalTracker?.initialize(userText);
    let reason: TurnEndReason = 'done';
    try {
      await this.append({ type: 'turn_started', turnId });
      this.deps.budget.start();
      await this.appendAndPush({ type: 'user_input', content: userText });
      reason = await this.runSteps();
    } catch (err) {
      // BudgetStop 是计划内熔断，直接映射原因；中断映射 interrupted；其余落 error 事件
      if (err instanceof BudgetStop) {
        reason = err.reason;
      } else if (err instanceof InterruptedError) {
        reason = 'interrupted';
      } else {
        reason = 'error';
        await this.appendError(err);
      }
    } finally {
      await this.finishTurn(turnId, reason);
    }
    return reason;
  }

  private async runSteps(): Promise<TurnEndReason> {
    const { budget, context, logger } = this.deps;
    for (;;) {
      if (this.interruptFlag) return 'interrupted';
      budget.countStep();
      budget.guard();
      const built = await context.build();
      if (built.elidedCount > 0) {
        await this.append({
          type: 'context_elided',
          count: built.elidedCount,
          freedEstTokens: built.freedEstTokens,
        });
      }
      // 目标漂移提醒：临时注入本轮消息（不落库），不污染事件流
      const drift = this.deps.goalTracker?.checkDrift(
        budget.snapshot().steps,
        this.recentToolCalls,
      );
      const messages = drift !== undefined
        ? [...built.messages, { role: 'user' as const, text: drift }]
        : built.messages;
      const resp = await this.chat(messages);
      budget.addUsage(resp.usage);
      this.turnUsage.inputTokens += resp.usage.inputTokens;
      this.turnUsage.outputTokens += resp.usage.outputTokens;
      this.observeCalibration(built.estTokens, resp.usage);
      this.emitStatus(built);

      // max_tokens 截断：丢弃可能不完整的 toolCalls，落库文本并注入续写
      if (resp.stopReason === 'max_tokens') {
        await this.appendAndPush({
          type: 'assistant_text',
          text: resp.text,
          toolCalls: [],
        });
        if (this.truncationCount >= MAX_CONTINUATIONS) {
          // 续写次数用尽：按当前输出收尾，避免死循环
          return 'done';
        }
        this.truncationCount += 1;
        await this.appendAndPush({
          type: 'user_input',
          content: '[上一回复因达到 max_tokens 被截断，请从被截断处继续，不要重复已输出内容]',
        });
        continue;
      }
      this.truncationCount = 0;

      await this.appendAndPush({
        type: 'assistant_text',
        text: resp.text,
        toolCalls: resp.toolCalls,
      });
      if (resp.toolCalls.length === 0) return 'done';
      await this.executeTools(resp.toolCalls);
    }
  }

  private async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    try {
      const client = this.deps.router.getClient('main');
      const resp = await client.chat(this.toRequest(messages), {
        onTextDelta: (delta) => this.deps.bus.emit('llm_delta', delta),
        ...(this.turnAbort !== undefined ? { signal: this.turnAbort.signal } : {}),
      });
      this.deps.costTracker.record(
        {
          role: 'main',
          provider: this.deps.router.getProvider('main'),
          model: client.model,
          inputTokens: resp.usage.inputTokens,
          outputTokens: resp.usage.outputTokens,
        },
        this.priceFor(client),
      );
      return resp;
    } catch (err) {
      // 防御：熔断异常不该在这儿抛，别包丢 reason
      if (err instanceof BudgetStop) throw err;
      // 中断：abort 错误 → 专用标记（区别于其他 LLM 错误）
      if (this.turnAbort?.signal.aborted) {
        throw new InterruptedError();
      }
      throw new LlmStageError(err);
    }
  }

  /**
   * 批量执行工具调用。
   * 全 read/net 时并发执行（结果按 callId 原顺序落库，保证重放确定）；
   * 含 write/danger 时串行（写操作可能有依赖/冲突，保守）。
   */
  private async executeTools(toolCalls: ToolCall[]): Promise<void> {
    // 1) 逐个落库 tool_call，拿到事件序号
    const entries: { toolCall: ToolCall; seq: number }[] = [];
    for (const toolCall of toolCalls) {
      this.recentToolCalls.push(toolCall);
      const envelope = await this.appendAndPush({
        type: 'tool_call',
        callId: toolCall.callId,
        toolName: toolCall.toolName,
        args: toolCall.args,
      });
      entries.push({ toolCall, seq: envelope.seq });
    }

    // 2) 判断是否可并发：全部 read/net
    const canParallel = entries.every(({ toolCall }) => {
      const tool = this.deps.tools.get(toolCall.toolName);
      return tool !== undefined && (tool.risk === 'read' || tool.risk === 'net');
    });

    // 3) 执行
    if (canParallel) {
      // 并发执行：结果存 Map，按 callId 原顺序落库
      const results = new Map<string, ToolResultEvent>();
      await Promise.all(
        entries.map(async ({ toolCall, seq }) => {
          results.set(toolCall.callId, await this.executeToolCore(toolCall, seq));
        }),
      );
      for (const { toolCall } of entries) {
        await this.appendAndPush(results.get(toolCall.callId)!);
      }
      return;
    }

    for (const { toolCall, seq } of entries) {
      await this.appendAndPush(await this.executeToolCore(toolCall, seq));
    }
  }

  /** 执行单个工具并返回 tool_result 事件（不落库）。权限/重试/快照逻辑与串行版一致。 */
  private async executeToolCore(toolCall: ToolCall, seq: number): Promise<ToolResultEvent> {
    const tool = this.deps.tools.get(toolCall.toolName);
    if (tool === undefined) {
      return {
        type: 'tool_result',
        callId: toolCall.callId,
        ok: false,
        content: `unknown tool: ${toolCall.toolName}`,
        durationMs: 0,
      };
    }
    const decision = await this.deps.permission.request(
      tool,
      toolCall.args,
      toolCall.callId,
      this.deps.cwd,
    );
    if (!decision.approved) {
      return {
        type: 'tool_result',
        callId: toolCall.callId,
        ok: false,
        content: 'User denied this action.',
        durationMs: 0,
      };
    }

    const maxRetries = 3;
    const startedAt = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let result: ToolResult;
      try {
        const checkpoint = this.deps.checkpoint;
        result = await tool.run(toolCall.args, {
          sessionId: this.deps.sessionId,
          cwd: this.deps.cwd,
          logger: this.deps.logger,
          sandbox: this.deps.sandbox,
          ...(checkpoint !== undefined
            ? {
                snapshotBeforeWrite: (relPath: string) =>
                  checkpoint.snapshotBeforeWrite(relPath, seq),
                currentSeq: seq,
              }
            : {}),
        });
      } catch (err) {
        // 契约：run() 永不 throw；违约降级为失败结果，回合继续
        result = { ok: false, content: `tool crashed: ${String(err)}` };
      }

      // 成功或非瞬态错误 → 直接返回
      if (result.ok || !isTransientError(result.content)) {
        return {
          type: 'tool_result',
          callId: toolCall.callId,
          ok: result.ok,
          content: result.content,
          durationMs: Date.now() - startedAt,
        };
      }

      // 瞬态错误且还有重试机会 → 退避后重试
      if (attempt < maxRetries) {
        const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
        await this.sleep(delayMs);
        continue;
      }

      // 重试用尽 → 附加重试次数信息
      const exhaustedContent = `${result.content}\nRetries: ${maxRetries}/${maxRetries}`;
      return {
        type: 'tool_result',
        callId: toolCall.callId,
        ok: false,
        content: exhaustedContent,
        durationMs: Date.now() - startedAt,
      };
    }

    // 不可达（TS 需要显式返回值）
    return {
      type: 'tool_result',
      callId: toolCall.callId,
      ok: false,
      content: 'unreachable',
      durationMs: 0,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 用真实 inputTokens 校准该模型估算比值，并 debug 记录（§10.1） */
  private observeCalibration(estimatedTokens: number, usage: Usage): void {
    if (this.deps.tokenCalibrator === undefined) return;
    const provider = this.deps.router.getProvider('main');
    const model = this.deps.router.getClient('main').model;
    this.deps.tokenCalibrator.observe(provider, model, estimatedTokens, usage.inputTokens);
    this.deps.logger.debug('token calibration', {
      provider,
      model,
      estimated: estimatedTokens,
      actual: usage.inputTokens,
      ratio: Number(this.deps.tokenCalibrator.ratio(provider, model).toFixed(2)),
    });
  }

  /** 查主角色当前模型的价格；未配置价格表返回 undefined */
  private priceFor(client: LLMClient): ModelPrice | undefined {
    if (this.deps.pricing === undefined) return undefined;
    return lookupPrice(this.deps.pricing, this.deps.router.getProvider('main'), client.model);
  }

  private toRequest(messages: ChatMessage[]): ChatRequest {
    const { systemPrompt, maxTokens, temperature, tools } = this.deps;
    const goalInjection = this.deps.goalTracker?.toSystemPromptInjection();
    const system = goalInjection !== undefined ? `${systemPrompt}\n\n${goalInjection}` : systemPrompt;
    const toolSpecs = tools.specs(this.deps.toolsSchemaMode ?? 'full');
    return temperature !== undefined
      ? { system, messages, tools: toolSpecs, maxTokens, temperature }
      : { system, messages, tools: toolSpecs, maxTokens };
  }

  /** 落库 + 广播 + 投影。先 append 后 push：append 抛错时上下文保持一致 */
  private async appendAndPush(event: AgentEvent): Promise<EventEnvelope> {
    const envelope = await this.append(event);
    this.deps.context.push(event);
    return envelope;
  }

  private async append(event: AgentEvent): Promise<EventEnvelope> {
    const envelope = await this.deps.store.append(this.deps.sessionId, event);
    this.deps.bus.emit('event', envelope);
    return envelope;
  }

  private async appendError(err: unknown): Promise<void> {
    const stage = err instanceof LlmStageError ? 'llm' : 'loop';
    const original = err instanceof LlmStageError ? err.original : err;
    try {
      await this.append({
        type: 'error',
        stage,
        message: String(original),
        recoverable: original instanceof TransientError,
      });
    } catch (storageErr) {
      this.deps.logger.error('failed to persist error event', { error: String(storageErr) });
    }
  }

  private emitStatus(built: ContextBuildResult): void {
    const snapshot = this.deps.budget.snapshot();
    this.deps.bus.emit('status', {
      step: snapshot.steps,
      maxSteps: snapshot.limits.maxStepsPerTurn,
      estTokens: built.estTokens,
      bodyBudgetTokens: built.bodyBudgetTokens,
      usage: { ...this.turnUsage },
    });
  }

  /** turn_completed 落库失败不允许掩盖真实结束原因；总线广播始终执行 */
  private async finishTurn(turnId: string, reason: TurnEndReason): Promise<void> {
    try {
      await this.append({ type: 'turn_completed', turnId, reason, usage: this.turnUsage });
    } catch (err) {
      this.deps.logger.error('failed to persist turn_completed event', { error: String(err) });
    }
    this.deps.bus.emit('turn_completed', { reason, usage: { ...this.turnUsage } });
  }
}
