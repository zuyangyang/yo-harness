/**
 * 认证 hook：封装 useAuthStore，提供简洁的组件 API。
 */
import { useEffect } from 'react';

import { useAuthStore } from '../stores/auth.js';

export function useAuth() {
  const { user, isAuthenticated, isLoading, error, login, register, logout, loadUser, clearError } =
    useAuthStore();

  useEffect(() => {
    if (!isAuthenticated) {
      void loadUser();
    }
  }, []);

  return {
    user,
    isAuthenticated,
    isLoading,
    error,
    login,
    register,
    logout,
    clearError,
  };
}
