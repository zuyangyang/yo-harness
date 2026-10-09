/**
 * 定时任务状态管理（Zustand）。
 */
import { create } from 'zustand';

import { api, type ScheduledTask, type ScheduleInput } from '../api/client.js';

interface ScheduleState {
  schedules: ScheduledTask[];
  isLoading: boolean;
  error: string | null;

  load: () => Promise<void>;
  create: (input: ScheduleInput) => Promise<ScheduledTask>;
  update: (id: string, patch: Partial<ScheduleInput>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  toggle: (id: string, enabled: boolean) => Promise<void>;
  runNow: (id: string) => Promise<void>;
  clearError: () => void;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export const useScheduleStore = create<ScheduleState>()((set, get) => ({
  schedules: [],
  isLoading: false,
  error: null,

  load: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.schedules.list();
      set({ schedules: res.schedules, isLoading: false });
    } catch (err) {
      set({ isLoading: false, error: message(err, 'Failed to load schedules') });
    }
  },

  create: async (input) => {
    try {
      const res = await api.schedules.create(input);
      set({ schedules: [res.schedule, ...get().schedules] });
      return res.schedule;
    } catch (err) {
      set({ error: message(err, 'Failed to create schedule') });
      throw err;
    }
  },

  update: async (id, patch) => {
    try {
      const res = await api.schedules.update(id, patch);
      set({ schedules: get().schedules.map((s) => (s.id === id ? res.schedule : s)) });
    } catch (err) {
      set({ error: message(err, 'Failed to update schedule') });
      throw err;
    }
  },

  remove: async (id) => {
    try {
      await api.schedules.delete(id);
      set({ schedules: get().schedules.filter((s) => s.id !== id) });
    } catch (err) {
      set({ error: message(err, 'Failed to delete schedule') });
      throw err;
    }
  },

  toggle: async (id, enabled) => {
    await get().update(id, { enabled });
  },

  runNow: async (id) => {
    try {
      await api.schedules.runNow(id);
    } catch (err) {
      set({ error: message(err, 'Failed to trigger schedule') });
      throw err;
    }
  },

  clearError: () => set({ error: null }),
}));
