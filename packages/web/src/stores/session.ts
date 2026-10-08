/**
 * 会话状态管理（Zustand）。
 *
 * 设计约束：
 * - 会话列表：从服务端拉取，支持刷新
 * - 当前会话：选中后订阅 WebSocket 事件流
 * - 事件缓冲：每个会话的事件按 seq 排序，用于渲染消息列表
 */
import { create } from 'zustand';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { api, type Session, type SessionUpdateInput } from '../api/client.js';
import { wsClient } from '../api/websocket.js';

interface SessionState {
  sessions: Session[];
  currentSessionId: string | null;
  events: Map<string, EventEnvelope[]>;
  /** 每个会话当前未提交的 LLM 流式文本（assistant_text 到达即清空） */
  deltas: Map<string, string>;
  isLoading: boolean;
  error: string | null;

  loadSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  createSession: (model?: string, cwd?: string, workspaceId?: string | null) => Promise<Session>;
  updateSession: (id: string, patch: SessionUpdateInput) => Promise<Session>;
  renameSession: (id: string, title: string) => Promise<void>;
  togglePin: (id: string, pinned: boolean) => Promise<void>;
  archiveSession: (id: string) => Promise<void>;
  moveSession: (id: string, workspaceId: string | null) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  /** 回退重新生成某条 user 消息对应的 turn（删除其后旧事件并重发原文） */
  regenerateTurn: (sessionId: string, userInputSeq: number) => Promise<void>;
  /** 编辑某条 user 消息并以新内容重发 */
  editTurn: (sessionId: string, userInputSeq: number, content: string) => Promise<void>;
  /** 丢弃本地某会话 seq >= fromSeq 的事件（服务端回退通知的对齐动作） */
  truncateEvents: (sessionId: string, fromSeq: number) => void;
  addEvent: (sessionId: string, envelope: EventEnvelope) => void;
  appendDelta: (sessionId: string, delta: string) => void;
  clearError: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  currentSessionId: null,
  events: new Map(),
  deltas: new Map(),
  isLoading: false,
  error: null,

  loadSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.sessions.list({ limit: 200 });
      set({ sessions: res.sessions, isLoading: false });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load sessions',
      });
    }
  },

  selectSession: async (id) => {
    const { currentSessionId } = get();
    if (currentSessionId === id) return;

    // Unsubscribe from previous session
    if (currentSessionId) {
      wsClient.unsubscribe(currentSessionId);
    }

    set({ currentSessionId: id, error: null });

    // Subscribe to new session
    wsClient.subscribe(id);

    // Load events if not already cached
    const { events } = get();
    if (!events.has(id)) {
      try {
        const res = await api.sessions.getEvents(id);
        const sorted = (res.events as EventEnvelope[]).sort((a, b) => a.seq - b.seq);
        set({ events: new Map(events).set(id, sorted) });
      } catch (err) {
        set({
          error: err instanceof Error ? err.message : 'Failed to load events',
        });
      }
    }
  },

  createSession: async (model, cwd, workspaceId) => {
    try {
      const res = await api.sessions.create({
        ...(model !== undefined ? { model } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
      const session = res.session;
      set({ sessions: [session, ...get().sessions] });
      return session;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to create session',
      });
      throw err;
    }
  },

  updateSession: async (id, patch) => {
    try {
      const res = await api.sessions.update(id, patch);
      const updated = res.session;
      set({ sessions: get().sessions.map((s) => (s.id === id ? updated : s)) });
      return updated;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to update session',
      });
      throw err;
    }
  },

  renameSession: async (id, title) => {
    await get().updateSession(id, { title });
  },

  togglePin: async (id, pinned) => {
    await get().updateSession(id, { pinned });
  },

  archiveSession: async (id) => {
    await get().updateSession(id, { status: 'archived' });
  },

  moveSession: async (id, workspaceId) => {
    await get().updateSession(id, { workspaceId });
  },

  deleteSession: async (id) => {
    try {
      await api.sessions.delete(id);
      const { sessions, currentSessionId, deltas } = get();
      const nextDeltas = new Map(deltas);
      nextDeltas.delete(id);
      set({
        sessions: sessions.filter((s) => s.id !== id),
        currentSessionId: currentSessionId === id ? null : currentSessionId,
        deltas: nextDeltas,
      });
      if (currentSessionId === id) {
        wsClient.unsubscribe(id);
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to delete session',
      });
    }
  },

  sendMessage: async (content) => {
    const { currentSessionId } = get();
    if (!currentSessionId) {
      set({ error: 'No session selected' });
      return;
    }

    try {
      await api.sessions.sendMessage(currentSessionId, content);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to send message',
      });
    }
  },

  regenerateTurn: async (sessionId, userInputSeq) => {
    const { truncateEvents } = get();
    // 乐观回退：先丢弃本地旧回复，服务端成功后新事件按新 seq 追加；
    // 失败时下面拉回完整事件流恢复。
    truncateEvents(sessionId, userInputSeq);
    try {
      await api.sessions.regenerateTurn(sessionId, userInputSeq);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to regenerate response',
      });
      await reloadEvents(sessionId, set, get);
      throw err;
    }
  },

  editTurn: async (sessionId, userInputSeq, content) => {
    const { truncateEvents } = get();
    truncateEvents(sessionId, userInputSeq);
    try {
      await api.sessions.editTurn(sessionId, userInputSeq, content);
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to edit message',
      });
      await reloadEvents(sessionId, set, get);
      throw err;
    }
  },

  truncateEvents: (sessionId, fromSeq) => {
    const { events, deltas } = get();
    const sessionEvents = events.get(sessionId);
    if (sessionEvents === undefined) return;
    const kept = sessionEvents.filter((e) => e.seq < fromSeq);
    if (kept.length === sessionEvents.length) return;

    const nextEvents = new Map(events).set(sessionId, kept);
    // 回退使本轮流式增量失效，必须一并丢弃
    if (deltas.has(sessionId)) {
      const nextDeltas = new Map(deltas);
      nextDeltas.delete(sessionId);
      set({ events: nextEvents, deltas: nextDeltas });
      return;
    }
    set({ events: nextEvents });
  },

  addEvent: (sessionId, envelope) => {
    const { events, deltas } = get();
    const sessionEvents = events.get(sessionId) ?? [];
    sessionEvents.push(envelope);
    sessionEvents.sort((a, b) => a.seq - b.seq);
    const nextEvents = new Map(events).set(sessionId, sessionEvents);

    // assistant_text 是流式文本的最终提交；turn_completed 兜底，避免残留半截流
    const commit =
      envelope.payload.type === 'assistant_text' || envelope.payload.type === 'turn_completed';
    if (commit && deltas.has(sessionId)) {
      const nextDeltas = new Map(deltas);
      nextDeltas.delete(sessionId);
      set({ events: nextEvents, deltas: nextDeltas });
      return;
    }
    set({ events: nextEvents });
  },

  appendDelta: (sessionId, delta) => {
    if (delta === '') return;
    const { deltas } = get();
    const current = deltas.get(sessionId) ?? '';
    set({ deltas: new Map(deltas).set(sessionId, current + delta) });
  },

  clearError: () => set({ error: null }),
}));

/** 回退请求失败后重新拉取该会话完整事件流，恢复乐观删除的本地状态。 */
async function reloadEvents(
  sessionId: string,
  set: (
    partial:
      | Partial<SessionState>
      | ((state: SessionState) => Partial<SessionState>),
  ) => void,
  get: () => SessionState,
): Promise<void> {
  try {
    const res = await api.sessions.getEvents(sessionId);
    const sorted = (res.events as EventEnvelope[]).sort((a, b) => a.seq - b.seq);
    set({ events: new Map(get().events).set(sessionId, sorted) });
  } catch {
    // 恢复失败仅保留错误提示；下次选中会话会重新拉取
  }
}
