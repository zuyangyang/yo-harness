/**
 * 站内通知状态管理（Zustand）。
 *
 * 定时任务运行结束时通过 WebSocket task.completed 到达，前端仅做未读 +1 与刷新。
 */
import { create } from 'zustand';

import { api, type Notification } from '../api/client.js';

interface NotificationState {
  notifications: Notification[];
  unread: number;
  isLoading: boolean;

  load: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** WebSocket 收到 task.completed 时本地 +1，避免额外请求 */
  bumpUnread: () => void;
}

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  notifications: [],
  unread: 0,
  isLoading: false,

  load: async () => {
    set({ isLoading: true });
    try {
      const res = await api.notifications.list();
      set({ notifications: res.notifications, unread: res.unread, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  markRead: async (id) => {
    try {
      await api.notifications.markRead(id);
      set({
        notifications: get().notifications.map((n) =>
          n.id === id ? { ...n, readAt: new Date().toISOString() } : n,
        ),
        unread: Math.max(0, get().unread - 1),
      });
    } catch {
      // 忽略：下次 load 会纠正
    }
  },

  markAllRead: async () => {
    try {
      await api.notifications.markAllRead();
      set({
        notifications: get().notifications.map((n) =>
          n.readAt === null ? { ...n, readAt: new Date().toISOString() } : n,
        ),
        unread: 0,
      });
    } catch {
      // 忽略
    }
  },

  bumpUnread: () => set({ unread: get().unread + 1 }),
}));
