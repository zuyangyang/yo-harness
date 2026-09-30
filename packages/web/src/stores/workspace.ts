/**
 * 工作区状态管理（Zustand）。
 *
 * 设计约束：
 * - 工作区列表：从服务端拉取，含每个工作区的 active 会话数（sessionCount）
 * - 增删改：调用 REST API 后在本地同步更新
 */
import { create } from 'zustand';

import { api, type Workspace } from '../api/client.js';

export interface WorkspaceCreateInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
}

export interface WorkspacePatch {
  name?: string;
  description?: string;
  color?: string;
  icon?: string;
  sortOrder?: number;
}

interface WorkspaceState {
  workspaces: Workspace[];
  isLoading: boolean;
  error: string | null;

  loadWorkspaces: () => Promise<void>;
  createWorkspace: (input: WorkspaceCreateInput) => Promise<Workspace>;
  updateWorkspace: (id: string, patch: WorkspacePatch) => Promise<void>;
  deleteWorkspace: (id: string, purge?: boolean) => Promise<void>;
  clearError: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  workspaces: [],
  isLoading: false,
  error: null,

  loadWorkspaces: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.workspaces.list();
      set({ workspaces: res.workspaces, isLoading: false });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load workspaces',
      });
    }
  },

  createWorkspace: async (input) => {
    try {
      const res = await api.workspaces.create(input);
      const workspace = res.workspace;
      set({ workspaces: [...get().workspaces, workspace] });
      return workspace;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to create workspace',
      });
      throw err;
    }
  },

  updateWorkspace: async (id, patch) => {
    try {
      const res = await api.workspaces.update(id, patch);
      const updated = res.workspace;
      set({
        workspaces: get().workspaces.map((w) => (w.id === id ? updated : w)),
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to update workspace',
      });
      throw err;
    }
  },

  deleteWorkspace: async (id, purge = false) => {
    try {
      await api.workspaces.delete(id, purge);
      set({ workspaces: get().workspaces.filter((w) => w.id !== id) });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to delete workspace',
      });
      throw err;
    }
  },

  clearError: () => set({ error: null }),
}));
