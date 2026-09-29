/**
 * 认证状态管理（Zustand）。
 *
 * 设计约束：
 * - 持久化：token 存 localStorage，刷新页面保持登录态
 * - 单例：全局唯一 store，组件通过 useAuthStore() 订阅
 * - 同步 API client：setToken/clearToken 同步到 api client，确保请求自动附加 Authorization
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { api, clearToken, setToken } from '../api/client.js';
import { wsClient } from '../api/websocket.js';

export interface User {
  id: string;
  username: string;
  role: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (tenantId: string, username: string, password: string) => Promise<void>;
  register: (tenantId: string, username: string, password: string, email?: string) => Promise<void>;
  logout: () => void;
  loadUser: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      login: async (tenantId, username, password) => {
        set({ isLoading: true, error: null });
        try {
          const res = await api.auth.login({ tenantId, username, password });
          setToken(res.accessToken);
          wsClient.connect();
          set({
            user: res.user,
            token: res.accessToken,
            refreshToken: res.refreshToken,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (err) {
          set({
            isLoading: false,
            error: err instanceof Error ? err.message : 'Login failed',
          });
          throw err;
        }
      },

      register: async (tenantId, username, password, email) => {
        set({ isLoading: true, error: null });
        try {
          const res = await api.auth.register({ tenantId, username, password, email });
          setToken(res.accessToken);
          wsClient.connect();
          set({
            user: res.user,
            token: res.accessToken,
            refreshToken: res.refreshToken,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (err) {
          set({
            isLoading: false,
            error: err instanceof Error ? err.message : 'Registration failed',
          });
          throw err;
        }
      },

      logout: () => {
        clearToken();
        wsClient.disconnect();
        set({
          user: null,
          token: null,
          refreshToken: null,
          isAuthenticated: false,
        });
      },

      loadUser: async () => {
        const { token, refreshToken } = get();
        if (!token) return;

        setToken(token);
        try {
          const res = await api.auth.me();
          wsClient.connect();
          set({
            user: res.user,
            isAuthenticated: true,
          });
        } catch {
          if (!refreshToken) {
            clearToken();
            set({ user: null, token: null, refreshToken: null, isAuthenticated: false });
            return;
          }
          try {
            const refreshRes = await api.auth.refresh(refreshToken);
            setToken(refreshRes.accessToken);
            const meRes = await api.auth.me();
            wsClient.connect();
            set({
              user: meRes.user,
              token: refreshRes.accessToken,
              isAuthenticated: true,
            });
          } catch {
            clearToken();
            set({ user: null, token: null, refreshToken: null, isAuthenticated: false });
          }
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'yo-auth',
      partialize: (state) => ({ token: state.token, refreshToken: state.refreshToken }),
    },
  ),
);
