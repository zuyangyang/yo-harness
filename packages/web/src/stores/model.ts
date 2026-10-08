/**
 * 模型配置状态管理（Zustand）。
 *
 * 设计文档 docs/MODEL-CONFIG-DESIGN.md §11。
 *
 * 约束：
 * - 服务端是唯一事实来源：写操作后以响应体回填，避免本地与服务端漂移；
 * - 密钥从不保存在前端状态里（只在提交瞬间存在于受控输入框）；
 * - source 用于提示「当前生效配置来自 Web UI / .env / 默认」。
 */
import { create } from 'zustand';

import {
  api,
  type ConfigSource,
  type DiscoverModelsInput,
  type ModelDescriptor,
  type ModelSelection,
  type ProviderProfile,
  type SaveProviderInput,
} from '../api/client.js';

interface ModelState {
  providers: ProviderProfile[];
  active: ModelSelection;
  source: ConfigSource;
  warnings: string[];
  isLoading: boolean;
  error: string | null;

  load: () => Promise<void>;
  saveProvider: (id: string, input: SaveProviderInput) => Promise<ProviderProfile>;
  deleteProvider: (id: string) => Promise<void>;
  saveActive: (selection: ModelSelection) => Promise<void>;
  discover: (input: DiscoverModelsInput) => Promise<ModelDescriptor[]>;
  clearError: () => void;
}

const EMPTY_ACTIVE: ModelSelection = { providerId: '', model: '' };

/** 全局默认模型的会话标签（"providerId/modelId"）；未配置时 undefined（沿用服务端默认） */
export function defaultModelLabel(selection: ModelSelection): string | undefined {
  if (selection.providerId === '' || selection.model === '') return undefined;
  return `${selection.providerId}/${selection.model}`;
}

export const useModelStore = create<ModelState>()((set, get) => ({
  providers: [],
  active: EMPTY_ACTIVE,
  source: 'default',
  warnings: [],
  isLoading: false,
  error: null,

  load: async () => {
    set({ isLoading: true, error: null });
    try {
      const view = await api.models.list();
      set({
        providers: view.providers,
        active: view.active,
        source: view.source,
        warnings: view.warnings,
        isLoading: false,
      });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load model config',
      });
    }
  },

  saveProvider: async (id, input) => {
    try {
      const res = await api.models.saveProvider(id, input);
      const exists = get().providers.some((p) => p.id === res.provider.id);
      set({
        providers: exists
          ? get().providers.map((p) => (p.id === res.provider.id ? res.provider : p))
          : [...get().providers, res.provider],
      });
      await get().load();
      return res.provider;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save provider' });
      throw err;
    }
  },

  deleteProvider: async (id) => {
    try {
      await api.models.deleteProvider(id);
      set({ providers: get().providers.filter((p) => p.id !== id) });
      await get().load();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete provider' });
      throw err;
    }
  },

  saveActive: async (selection) => {
    try {
      const res = await api.models.saveActive(selection);
      set({ active: res.active, source: 'web' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save model selection' });
      throw err;
    }
  },

  discover: async (input) => {
    const res = await api.models.discover(input);
    return res.models;
  },

  clearError: () => set({ error: null }),
}));
