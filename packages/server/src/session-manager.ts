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
import { Compressor } from '@yo-harness/core/core/compressor.js';
import { FallbackSummarizer } from '@yo-harness/core/core/summarizer.js';
import { EventBus } from '@yo-harness/core/core/event-bus.js';
import {
  createInteractivePermission,
  resolvePermissionMode,
  withApprovalEvents,
  type ApprovalRequest,
  type ApprovalAnswer,
  type PermissionManager,
  type PermissionMode,
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
  /** 会话级权限管理器（支持运行期 setMode） */
  permission: PermissionManager;
}

interface DeferredApproval {
  approval: PendingApproval;
  resolve: (answer: ApprovalAnswer) => void;
}

/** 单个会话实际使用的模型运行时 */
export interface SessionRuntime {
  router: ModelRouter;
  contextWindow: number;
  /** 实际生效的模型 id（写入 session_started 事件，供 UI 标注生成模型） */
  model: string;
}

export interface SessionManagerDeps {
  eventStore: EventStore;
  sessionStore: SessionStore;
  tools: ToolResolver;
  /** 解析该会话生效的运行时：会话级模型优先，其次全局默认（可在运行期变更） */
  resolveRuntime: (session: Session) => Promise<SessionRuntime>;
  costTracker: CostTracker;
  sandbox: SandboxProvider;
  logger: Logger;
  systemPrompt: string;
  maxTokens: number;
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
    await this.startTurn(sessionId, message);
    return { accepted: true };
  }

  /**
   * 重新生成：回退到指定 user_input（缺省为最近一条）并重发原文。
   *
   * 回退会删除该 user_input 及其之后的全部事件（含旧回复），因此其后的
   * 所有 turn 一并丢弃 —— 与「从这条消息重新开始」的语义一致。
   *
   * @param sessionId - 目标会话。
   * @param userInputSeq - 目标 user_input 事件的 seq；缺省 = 最近一条。
   * @returns 受理结果与回退起点 seq（供前端丢弃本地旧事件）。
   */
  async regenerateTurn(
    sessionId: string,
    userInputSeq?: number,
  ): Promise<{ accepted: true; fromSeq: number }> {
    this.assertIdle(sessionId);
    const target = await this.findUserInput(sessionId, userInputSeq);
    await this.rewind(sessionId, target.seq);
    await this.startTurn(sessionId, target.content);
    return { accepted: true, fromSeq: target.seq };
  }

  /**
   * 编辑重发：回退到指定 user_input 并以其新内容重新运行。
   *
   * @param sessionId - 目标会话。
   * @param userInputSeq - 被编辑的 user_input 事件 seq。
   * @param content - 替换后的用户消息（去除首尾空白后不得为空）。
   * @returns 受理结果与回退起点 seq。
   */
  async editTurn(
    sessionId: string,
    userInputSeq: number,
    content: string,
  ): Promise<{ accepted: true; fromSeq: number }> {
    const text = content.trim();
    if (text === '') {
      throw new Error('content must not be empty');
    }
    this.assertIdle(sessionId);
    const target = await this.findUserInput(sessionId, userInputSeq);
    await this.rewind(sessionId, target.seq);
    await this.startTurn(sessionId, text);
    return { accepted: true, fromSeq: target.seq };
  }

  /** 创建并启动一轮：复用 sendMessage 的 running 守卫与后台执行语义。 */
  private async startTurn(sessionId: string, message: string): Promise<void> {
    const active = await this.getOrCreate(sessionId);
    if (active.running) {
      throw new Error('session already running a turn');
    }
    active.running = true;
    void this.runTurn(active, message).finally(() => {
      active.running = false;
    });
  }

  /** 仅当会话没有在途 turn 时允许回退，避免与正在执行的 loop 抢事件流。 */
  private assertIdle(sessionId: string): void {
    const active = this.active.get(sessionId);
    if (active?.running) {
      throw new Error('session already running a turn');
    }
  }

  private async findUserInput(
    sessionId: string,
    userInputSeq?: number,
  ): Promise<{ seq: number; content: string }> {
    const envelopes = await this.deps.eventStore.replay(sessionId);
    const match =
      userInputSeq === undefined
        ? [...envelopes].reverse().find((e) => e.payload.type === 'user_input')
        : envelopes.find((e) => e.seq === userInputSeq);
    if (match?.payload.type !== 'user_input') {
      throw new Error(
        userInputSeq === undefined
          ? 'no user message to regenerate'
          : `user message not found at seq ${userInputSeq}`,
      );
    }
    return { seq: match.seq, content: match.payload.content };
  }

  /**
   * 回退事件流：驱逐活跃 loop（其 ContextManager 仍持有已删除事件的消息投影），
   * 删除 seq >= fromSeq 的事件，并广播截断通知让所有标签页丢弃本地旧事件。
   */
  private async rewind(sessionId: string, fromSeq: number): Promise<void> {
    this.closeSession(sessionId);
    await this.deps.eventStore.deleteFrom(sessionId, fromSeq);
    this.deps.wsHub?.broadcastTruncated(sessionId, fromSeq);
  }

  private async runTurn(active: ActiveSession, message: string): Promise<TurnEndReason> {
    try {
      return await active.loop.runTurn(message);
    } catch (err) {
      this.deps.logger.error('turn failed', { sessionId: active.session.id, error: String(err) });
      return 'error';
    }
  }

  /**
   * 运行期应用会话权限模式（仅对已激活会话生效）。
   * mode=null 表示继承，回到全局默认。返回是否命中活跃会话。
   */
  applyPermissionMode(sessionId: string, mode: PermissionMode | null): boolean {
    const active = this.active.get(sessionId);
    if (!active) return false;
    active.permission.setMode(mode ?? resolvePermissionMode(this.deps.permission));
    return true;
  }

  interrupt(sessionId: string): Promise<void> {
    const active = this.active.get(sessionId);
    if (active) {
      active.loop.interrupt();
      // 关键：循环若正阻塞在 permission.request（等待审批），仅置中断标志
      // 无法唤醒它。取消未决审批并广播 cancelled，让 ask 立刻返回拒绝，
      // 循环收到 denied 结果后在下一步检查到中断标志并收尾（turn_completed）。
      this.cancelPendingForSession(sessionId);
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
    const resolution: 'once' | 'session' | 'deny' = !approved ? 'deny' : scope === 'session' ? 'session' : 'once';
    deferred.resolve(answer);
    this.pendingApprovals.delete(approvalId);
    this.deps.wsHub?.broadcastApprovalResolved(deferred.approval.sessionId, approvalId, resolution, 'user');
    return true;
  }

  /**
   * 单个会话的模型变更后丢弃缓存的 loop（运行中的 turn 不打断）。
   *
   * @returns 是否发生了驱逐
   */
  invalidateSession(sessionId: string): boolean {
    const active = this.active.get(sessionId);
    if (active === undefined) return false;
    if (active.running) return false;
    this.closeSession(sessionId);
    return true;
  }

  /**
   * 模型配置变更：驱逐**空闲**活跃会话，使其下一条消息用新配置重建 loop。
   *
   * 正在执行的 turn 不打断（避免半途换模型导致消息错乱）；结束后若已被驱逐，
   * 会话记录仍在 event store 中，下次消息会重放重建。
   *
   * @returns 被驱逐的会话数
   */
  onModelConfigChanged(): number {
    let evicted = 0;
    for (const [sessionId, active] of [...this.active.entries()]) {
      if (active.running) continue;
      this.closeSession(sessionId);
      evicted += 1;
    }
    return evicted;
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

    // LLM 流式增量：仅实时渲染，不落库；最终文本以 assistant_text 事件为准
    bus.on('llm_delta', (delta: string) => {
      this.deps.wsHub?.broadcastDelta(sessionId, delta);
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

    const runtime = await this.deps.resolveRuntime(session);

    const context = ContextManager.fromEvents(priorEvents, {
      contextWindow: runtime.contextWindow,
    });

    // 自适应压缩：server 端角色表恒空（无 compressor 角色），用零成本截断兜底，
    // 保证长对话超阈值时保留关键信息而非完全省略。
    context.setCompressor(new Compressor(new FallbackSummarizer()));

    const sink = async (event: AgentEvent): Promise<void> => {
      const envelope = await this.deps.eventStore.append(sessionId, event);
      bus.emit('event', envelope);
    };

    // 本次运行时的生效模型落库（会话级模型变更会重建 loop，从而开启新的一段运行时）。
    // 前端据此在每条回复右下角标注由哪个模型生成。
    await sink({ type: 'session_started', model: runtime.model, cwd: session.cwd });

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

      // ★ 关键：把待审批推送给订阅该会话的客户端，否则前端无入口可批准
      this.deps.wsHub?.broadcastApprovalRequest(sessionId, approval);

      return deferred.promise;
    };

    // 会话级权限模式覆盖全局默认（null = 继承）
    const policy: PermissionSettings =
      session.permissionMode !== null
        ? { ...this.deps.permission, mode: session.permissionMode }
        : this.deps.permission;
    const permission = createInteractivePermission(withApprovalEvents(serverAsk, sink), policy);

    const loop = new AgentLoop({
      sessionId,
      cwd: session.cwd,
      router: runtime.router,
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

    const active: ActiveSession = { session, loop, bus, running: false, permission };
    this.active.set(sessionId, active);
    return active;
  }

  private cancelPendingForSession(sessionId: string): void {
    for (const [id, deferred] of this.pendingApprovals.entries()) {
      if (deferred.approval.sessionId === sessionId) {
        deferred.resolve('no');
        this.pendingApprovals.delete(id);
        this.deps.wsHub?.broadcastApprovalCancelled(sessionId, id, 'session closed or interrupted');
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
