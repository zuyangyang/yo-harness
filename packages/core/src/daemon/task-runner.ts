/**
 * TaskRunner：无头 AgentLoop 包装器。
 *
 * 职责：
 * 1. 为后台任务创建 session + task 记录；
 * 2. 装配 AgentLoop（无 UI、无审批、yolo 模式）；
 * 3. 运行 runTurn()，捕获结果更新 task 状态；
 * 4. 提取最终摘要（最后一条 assistant_text）。
 *
 * 与交互式会话的差异：
 * - 无 Ink UI，无 AskBridge；
 * - 权限模式强制 yolo（后台任务无法交互审批）；
 * - 事件流写入 EventStore，CLI 通过 `yo task <id>` 重放查看。
 */
import { AgentLoop } from '../core/agent-loop.js';
import { TurnBudget } from '../core/budget.js';
import { ContextManager } from '../core/context-manager.js';
import { Compressor } from '../core/compressor.js';
import { FallbackSummarizer } from '../core/summarizer.js';
import { EventBus } from '../core/event-bus.js';
import { createNonInteractivePermission } from '../core/permission.js';
import type { EventStore, ToolResolver } from '../core/ports.js';
import { DEFAULT_PRICING_TABLE } from '../llm/pricing.js';
import type { CostTracker } from '../router/cost-tracker.js';
import type { ModelRouter } from '../router/model-router.js';
import type { Logger } from '../types/common.js';
import type { PricingTable } from '../types/pricing.js';
import type { TurnEndReason } from '../types/events.js';
import type { SandboxProvider } from '../types/sandbox.js';
import type { SessionStore } from '../core/ports.js';
import type { TaskStore } from '../storage/task-store.js';

export interface TaskRunnerDeps {
  taskStore: TaskStore;
  sessionStore: SessionStore;
  eventStore: EventStore;
  tools: ToolResolver;
  router: ModelRouter;
  costTracker: CostTracker;
  /** 价格表（缺省用内置默认） */
  pricing?: PricingTable;
  sandbox: SandboxProvider;
  logger: Logger;
  systemPrompt: string;
  maxTokens: number;
  budgetLimits: {
    maxStepsPerTurn: number;
    maxTokensPerTurn: number;
    maxTurnDurationMs: number;
  };
  contextWindow: number;
}

export interface RunTaskInput {
  taskId: string;
  prompt: string;
  cwd: string;
  model: string;
}

export interface RunTaskResult {
  taskId: string;
  sessionId: string;
  endReason: TurnEndReason;
  summary: string | null;
}

const SYSTEM_PROMPT = [
  'You are yo, a local-first personal agent running in the user terminal.',
  'You work inside a workspace directory; tool paths are resolved against it and escaping it is rejected.',
  'Accomplish tasks autonomously with the tools: read_file, write_file, list_dir, shell, web_fetch, web_search.',
  'Prefer small verifiable steps; after running tools, briefly report what you did.',
  'Reply in the same language the user writes in.',
].join('\n');

export class TaskRunner {
  constructor(private readonly deps: TaskRunnerDeps) {}

  async run(input: RunTaskInput): Promise<RunTaskResult> {
    const { taskStore, eventStore, tools, router, costTracker, logger } = this.deps;
    const pricing = this.deps.pricing ?? DEFAULT_PRICING_TABLE;

    const task = await taskStore.get(input.taskId);
    if (task === undefined) {
      throw new Error(`task not found: ${input.taskId}`);
    }

    const sessionId = task.sessionId;
    const bus = new EventBus();

    const context = ContextManager.fromEvents([], {
      contextWindow: this.deps.contextWindow,
    });

    // 自适应压缩：后台任务零成本截断兜底，保证长任务不超窗
    context.setCompressor(new Compressor(new FallbackSummarizer()));

    const permission = createNonInteractivePermission({ shellMode: 'yolo', shellAllowlist: [] });

    const loop = new AgentLoop({
      sessionId,
      cwd: input.cwd,
      router,
      costTracker,
      pricing,
      store: eventStore,
      tools,
      permission,
      budget: new TurnBudget(this.deps.budgetLimits),
      context,
      bus,
      sandbox: this.deps.sandbox,
      systemPrompt: this.deps.systemPrompt || SYSTEM_PROMPT,
      maxTokens: this.deps.maxTokens,
      logger,
    });

    await taskStore.updateStatus(input.taskId, 'running');

    let lastAssistantText = '';
    const onEvent = (envelope: { payload: { type: string; text?: string } }): void => {
      if (envelope.payload.type === 'assistant_text' && typeof envelope.payload.text === 'string') {
        lastAssistantText = envelope.payload.text;
      }
    };
    bus.on('event', onEvent);

    let endReason: TurnEndReason;
    let errorMessage: string | undefined;
    try {
      endReason = await loop.runTurn(input.prompt);
    } catch (err) {
      endReason = 'error';
      errorMessage = String(err);
      logger.error('task runner error', { taskId: input.taskId, error: String(err) });
    } finally {
      bus.off('event', onEvent);
    }
    endReason ??= 'error';

    const status = endReason === 'done' ? 'completed' : endReason === 'error' ? 'failed' : 'cancelled';
    const taskEndReason = endReason === 'done' ? 'end_turn' : endReason === 'max_steps' ? 'budget' : endReason === 'budget' ? 'budget' : endReason === 'interrupted' ? 'cancelled' : 'error';
    const summary = lastAssistantText.length > 0 ? lastAssistantText.slice(0, 500) : null;

    await taskStore.updateStatus(input.taskId, status, taskEndReason, errorMessage ?? undefined, summary ?? undefined);

    return {
      taskId: input.taskId,
      sessionId,
      endReason,
      summary,
    };
  }
}
