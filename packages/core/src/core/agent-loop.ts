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
import type { ChatMessage, ChatRequest, ChatResponse } from '../types/llm.js';
import type { ToolResult } from '../types/tools.js';
import type { SandboxProvider } from '../types/sandbox.js';
import { logTokenCalibration } from '../utils/tokens.js';
import type { TurnBudget } from './budget.js';
import type { ContextBuildResult, ContextManager } from './context-manager.js';
import type { EventBus } from './event-bus.js';
import type { EventStore, ToolResolver } from './ports.js';
import type { PermissionManager } from './permission.js';
import type { ModelRouter } from '../router/model-router.js';
import type { CostTracker } from '../router/cost-tracker.js';

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
}

/** LLM 阶段失败的标记：error 事件 stage='llm'，原始错误保存在 original */
class LlmStageError extends Error {
  constructor(public readonly original: unknown) {
    super(`llm chat failed: ${String(original)}`);
  }
}

export class AgentLoop {
  private interruptFlag = false;
  private turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly deps: AgentLoopDeps) {}

  /** 暴露上下文管理器：resume 重建 / CLI 检查用 */
  get context(): ContextManager {
    return this.deps.context;
  }

  /** 请求中断：当前工具结束后、下一次 LLM 调用前生效 */
  interrupt(): void {
    this.interruptFlag = true;
  }

  async runTurn(userText: string): Promise<TurnEndReason> {
    const turnId = randomUUID();
    this.interruptFlag = false;
    this.turnUsage = { inputTokens: 0, outputTokens: 0 };
    let reason: TurnEndReason = 'done';
    try {
      await this.append({ type: 'turn_started', turnId });
      this.deps.budget.start();
      await this.appendAndPush({ type: 'user_input', content: userText });
      reason = await this.runSteps();
    } catch (err) {
      // BudgetStop 是计划内熔断，直接映射原因；其余落 error 事件
      if (err instanceof BudgetStop) {
        reason = err.reason;
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
      const resp = await this.chat(built.messages);
      budget.addUsage(resp.usage);
      this.turnUsage.inputTokens += resp.usage.inputTokens;
      this.turnUsage.outputTokens += resp.usage.outputTokens;
      logTokenCalibration(logger, built.estTokens, resp.usage);
      this.emitStatus(built);
      await this.appendAndPush({
        type: 'assistant_text',
        text: resp.text,
        toolCalls: resp.toolCalls,
      });
      if (resp.toolCalls.length === 0) return 'done';
      for (const toolCall of resp.toolCalls) {
        await this.appendAndPush({
          type: 'tool_call',
          callId: toolCall.callId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        });
        await this.executeTool(toolCall);
      }
    }
  }

  private async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    try {
      const client = this.deps.router.getClient('main');
      const resp = await client.chat(this.toRequest(messages), {
        onTextDelta: (delta) => this.deps.bus.emit('llm_delta', delta),
      });
      this.deps.costTracker.record({
        role: 'main',
        provider: this.deps.router.getProvider('main'),
        model: client.name,
        inputTokens: resp.usage.inputTokens,
        outputTokens: resp.usage.outputTokens,
      });
      return resp;
    } catch (err) {
      // 防御：熔断异常不该在这儿抛，别包丢 reason
      if (err instanceof BudgetStop) throw err;
      throw new LlmStageError(err);
    }
  }

  private async executeTool(toolCall: ToolCall): Promise<void> {
    const tool = this.deps.tools.get(toolCall.toolName);
    if (tool === undefined) {
      await this.appendAndPush({
        type: 'tool_result',
        callId: toolCall.callId,
        ok: false,
        content: `unknown tool: ${toolCall.toolName}`,
        durationMs: 0,
      });
      return;
    }
    const decision = await this.deps.permission.request(
      tool,
      toolCall.args,
      toolCall.callId,
      this.deps.cwd,
    );
    if (!decision.approved) {
      await this.appendAndPush({
        type: 'tool_result',
        callId: toolCall.callId,
        ok: false,
        content: 'User denied this action.',
        durationMs: 0,
      });
      return;
    }

    const maxRetries = 3;
    const startedAt = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let result: ToolResult;
      try {
        result = await tool.run(toolCall.args, {
          sessionId: this.deps.sessionId,
          cwd: this.deps.cwd,
          logger: this.deps.logger,
          sandbox: this.deps.sandbox,
        });
      } catch (err) {
        // 契约：run() 永不 throw；违约降级为失败结果，回合继续
        result = { ok: false, content: `tool crashed: ${String(err)}` };
      }

      // 成功或非瞬态错误 → 直接返回
      if (result.ok || !isTransientError(result.content)) {
        await this.appendAndPush({
          type: 'tool_result',
          callId: toolCall.callId,
          ok: result.ok,
          content: result.content,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      // 瞬态错误且还有重试机会 → 退避后重试
      if (attempt < maxRetries) {
        const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
        await this.sleep(delayMs);
        continue;
      }

      // 重试用尽 → 附加重试次数信息
      const exhaustedContent = `${result.content}\nRetries: ${maxRetries}/${maxRetries}`;
      await this.appendAndPush({
        type: 'tool_result',
        callId: toolCall.callId,
        ok: false,
        content: exhaustedContent,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toRequest(messages: ChatMessage[]): ChatRequest {
    const { systemPrompt, maxTokens, temperature, tools } = this.deps;
    return temperature !== undefined
      ? { system: systemPrompt, messages, tools: tools.specs(), maxTokens, temperature }
      : { system: systemPrompt, messages, tools: tools.specs(), maxTokens };
  }

  /** 落库 + 广播 + 投影。先 append 后 push：append 抛错时上下文保持一致 */
  private async appendAndPush(event: AgentEvent): Promise<void> {
    await this.append(event);
    this.deps.context.push(event);
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
