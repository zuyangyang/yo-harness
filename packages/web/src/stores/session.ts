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
  addEvent: (sessionId: string, envelope: EventEnvelope) => void;
  clearError: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  currentSessionId: null,
  events: new Map(),
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
      const { sessions, currentSessionId } = get();
      set({
        sessions: sessions.filter((s) => s.id !== id),
        currentSessionId: currentSessionId === id ? null : currentSessionId,
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

  addEvent: (sessionId, envelope) => {
    const { events } = get();
    const sessionEvents = events.get(sessionId) ?? [];
    sessionEvents.push(envelope);
    sessionEvents.sort((a, b) => a.seq - b.seq);
    set({ events: new Map(events).set(sessionId, sessionEvents) });
  },

  clearError: () => set({ error: null }),
}));
