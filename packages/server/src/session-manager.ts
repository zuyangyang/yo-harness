/**
 * SessionManager：管理活跃 AgentLoop 实例 + 审批队列。
 *
 * 每个交互式会话在首次收到消息时惰性创建 AgentLoop（从事件流重建上下文），
 * 后续消息复用同一实例。后台任务由 TaskRunner 独立管理，不经过此处。
 *
 * 审批流程：
 * 1. AgentLoop 调用 permission.request() → 内部 ask() 阻塞
 * 2. ask() 在 pendingApprovals 中创建 Deferred
 * 3. withApprovalEvents 装饰器写入 approval_request 事件
 * 4. 客户端通过 REST / WebSocket 调用 resolveApproval()
 * 5. Deferred resolve → ask() 返回 → AgentLoop 继续执行
 */
import { randomUUID } from 'node:crypto';

import { AgentLoop } from '@yo-harness/core/core/agent-loop.js';
import { TurnBudget } from '@yo-harness/core/core/budget.js';
import { ContextManager } from '@yo-harness/core/core/context-manager.js';
import { EventBus } from '@yo-harness/core/core/event-bus.js';
import {
  createInteractivePermission,
  withApprovalEvents,
  type ApprovalRequest,
  type ApprovalAnswer,
  type PermissionSettings,
} from '@yo-harness/core/core/permission.js';
import type { EventStore, SessionStore, Session, ToolResolver } from '@yo-harness/core/core/ports.js';
import { deriveTitle } from '@yo-harness/core/utils/title.js';
import type { CostTracker } from '@yo-harness/core/router/cost-tracker.js';
import type { ModelRouter } from '@yo-harness/core/router/model-router.js';
import type { Logger } from '@yo-harness/core/types/common.js';
import type { AgentEvent, EventEnvelope, TurnEndReason } from '@yo-harness/core/types/events.js';
import type { SandboxProvider } from '@yo-harness/core/types/sandbox.js';
import type { WebSocketHub } from './ws/hub.js';

export interface PendingApproval {
  id: string;
  sessionId: string;
  callId: string;
  toolName: string;
  summary: string;
  createdAt: string;
}

interface ActiveSession {
  session: Session;
  loop: AgentLoop;
  bus: EventBus;
  running: boolean;
}

interface DeferredApproval {
  approval: PendingApproval;
  resolve: (answer: ApprovalAnswer) => void;
}

export interface SessionManagerDeps {
  eventStore: EventStore;
  sessionStore: SessionStore;
  tools: ToolResolver;
  router: ModelRouter;
  costTracker: CostTracker;
  sandbox: SandboxProvider;
  logger: Logger;
  systemPrompt: string;
  maxTokens: number;
  contextWindow: number;
  budgetLimits: { maxStepsPerTurn: number; maxTokensPerTurn: number; maxTurnDurationMs: number };
  permission: PermissionSettings;
  wsHub?: WebSocketHub;
}

export class SessionManager {
  private readonly active = new Map<string, ActiveSession>();
  private readonly pendingApprovals = new Map<string, DeferredApproval>();

  constructor(private readonly deps: SessionManagerDeps) {}

  setWebSocketHub(hub: WebSocketHub): void {
    (this.deps as { wsHub: WebSocketHub }).wsHub = hub;
  }

  async sendMessage(sessionId: string, message: string): Promise<{ accepted: true }> {
    const active = await this.getOrCreate(sessionId);
    if (active.running) {
      throw new Error('session already running a turn');
    }
    active.running = true;
    void this.runTurn(active, message).finally(() => {
      active.running = false;
    });
    return { accepted: true };
  }

  private async runTurn(active: ActiveSession, message: string): Promise<TurnEndReason> {
    try {
      return await active.loop.runTurn(message);
    } catch (err) {
      this.deps.logger.error('turn failed', { sessionId: active.session.id, error: String(err) });
      return 'error';
    }
  }

  interrupt(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (active) {
      active.loop.interrupt();
    }
    return Promise.resolve();
  }

  getPendingApprovals(sessionId: string): PendingApproval[] {
    const result: PendingApproval[] = [];
    for (const d of this.pendingApprovals.values()) {
      if (d.approval.sessionId === sessionId) {
        result.push(d.approval);
      }
    }
    return result;
  }

  resolveApproval(approvalId: string, approved: boolean, scope: 'once' | 'session' = 'once'): boolean {
    const deferred = this.pendingApprovals.get(approvalId);
    if (!deferred) return false;
    const answer: ApprovalAnswer = approved ? (scope === 'session' ? 'always' : 'yes') : 'no';
    deferred.resolve(answer);
    this.pendingApprovals.delete(approvalId);
    return true;
  }

  closeSession(sessionId: string): void {
    const active = this.active.get(sessionId);
    if (active) {
      active.loop.interrupt();
      this.active.delete(sessionId);
      this.cancelPendingForSession(sessionId);
    }
  }

  destroyAll(): Promise<void> {
    for (const sessionId of [...this.active.keys()]) {
      this.closeSession(sessionId);
    }
    return Promise.resolve();
  }

  private async getOrCreate(sessionId: string): Promise<ActiveSession> {
    const existing = this.active.get(sessionId);
    if (existing) return existing;

    const session = await this.deps.sessionStore.get(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    const envelopes = await this.deps.eventStore.replay(sessionId);
    const priorEvents = envelopes.map((e) => e.payload);

    const bus = new EventBus();
    bus.on('event', (envelope: EventEnvelope) => {
      this.deps.wsHub?.broadcast(sessionId, envelope);
    });

    // 首个 user_input 落库后自动补标题（仅当尚未命名且非自定义）
    let autoTitled = false;
    bus.on('event', (envelope: EventEnvelope) => {
      if (autoTitled) return;
      if (envelope.payload.type !== 'user_input') return;
      autoTitled = true;
      if (session.title !== '' || session.titleIsCustom) return;
      const title = deriveTitle(envelope.payload.content);
      if (title === '') return;
      void this.deps.sessionStore
        .updateTitle(session.id, title)
        .catch((err: unknown) =>
          this.deps.logger.warn('failed to auto-title session', { sessionId, error: String(err) }),
        );
    });

    const context = ContextManager.fromEvents(priorEvents, {
      contextWindow: this.deps.contextWindow,
    });

    const sink = async (event: AgentEvent): Promise<void> => {
      const envelope = await this.deps.eventStore.append(sessionId, event);
      bus.emit('event', envelope);
    };

    const serverAsk = async (request: ApprovalRequest): Promise<ApprovalAnswer> => {
      const approvalId = randomUUID();
      const deferred = new DeferredImpl<ApprovalAnswer>();
      const approval: PendingApproval = {
        id: approvalId,
        sessionId,
        callId: request.callId,
        toolName: request.toolName,
        summary: request.summary,
        createdAt: new Date().toISOString(),
      };
      this.pendingApprovals.set(approvalId, { approval, resolve: deferred.resolve.bind(deferred) });
      return deferred.promise;
    };

    const permission = createInteractivePermission(
      withApprovalEvents(serverAsk, sink),
      this.deps.permission,
    );

    const loop = new AgentLoop({
      sessionId,
      cwd: session.cwd,
      router: this.deps.router,
      costTracker: this.deps.costTracker,
      store: this.deps.eventStore,
      tools: this.deps.tools,
      permission,
      budget: new TurnBudget(this.deps.budgetLimits),
      context,
      bus,
      sandbox: this.deps.sandbox,
      systemPrompt: this.deps.systemPrompt,
      maxTokens: this.deps.maxTokens,
      logger: this.deps.logger,
    });

    const active: ActiveSession = { session, loop, bus, running: false };
    this.active.set(sessionId, active);
    return active;
  }

  private cancelPendingForSession(sessionId: string): void {
    for (const [id, deferred] of this.pendingApprovals.entries()) {
      if (deferred.approval.sessionId === sessionId) {
        deferred.resolve('no');
        this.pendingApprovals.delete(id);
      }
    }
  }
}

class DeferredImpl<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}
