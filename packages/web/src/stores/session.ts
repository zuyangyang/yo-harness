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
import { api, type Session } from '../api/client.js';
import { wsClient } from '../api/websocket.js';

interface SessionState {
  sessions: Session[];
  currentSessionId: string | null;
  events: Map<string, EventEnvelope[]>;
  isLoading: boolean;
  error: string | null;

  loadSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  createSession: (model?: string, cwd?: string) => Promise<Session>;
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
      const res = await api.sessions.list();
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

  createSession: async (model, cwd) => {
    try {
      const res = await api.sessions.create(model, cwd);
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
