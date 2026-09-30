/**
 * 全局 Toast 状态（Zustand）。
 *
 * 设计约束：
 * - 单一队列，右下角堆叠显示
 * - error 默认不自动消失（duration = 0），其余类型自动消失
 * - 通过 toast.{info,success,warning,error} 便捷函数触发
 */
import { create } from 'zustand';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  /** 自动消失时间（毫秒）；0 表示需手动关闭 */
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  push: (item: Omit<ToastItem, 'id'>) => void;
  remove: (id: string) => void;
  clear: () => void;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return 'toast-' + seq.toString(36) + '-' + Date.now().toString(36);
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (item) => set((s) => ({ toasts: [...s.toasts, { ...item, id: nextId() }] })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

export const toast = {
  info: (message: string, duration = 4000): void => {
    useToastStore.getState().push({ type: 'info', message, duration });
  },
  success: (message: string, duration = 3000): void => {
    useToastStore.getState().push({ type: 'success', message, duration });
  },
  warning: (message: string, duration = 5000): void => {
    useToastStore.getState().push({ type: 'warning', message, duration });
  },
  error: (message: string): void => {
    useToastStore.getState().push({ type: 'error', message, duration: 0 });
  },
};
