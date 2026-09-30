/**
 * UI 布局状态（Zustand + persist）。
 *
 * 设计约束：
 * - 布局偏好（侧栏折叠 / 右面板开关 / 当前模型）持久化到 localStorage
 * - 与业务状态（会话/事件）分离，避免布局改动污染会话 store
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  contextPanelOpen: boolean;
  model: string;

  toggleSidebar: () => void;
  toggleContextPanel: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setContextPanelOpen: (open: boolean) => void;
  setModel: (model: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      contextPanelOpen: false,
      model: '',

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setContextPanelOpen: (open) => set({ contextPanelOpen: open }),
      setModel: (model) => set({ model }),
    }),
    {
      name: 'yo-ui-prefs',
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        contextPanelOpen: s.contextPanelOpen,
        model: s.model,
      }),
    },
  ),
);
