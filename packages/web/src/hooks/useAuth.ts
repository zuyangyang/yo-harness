/**
 * 认证 hook：封装 useAuthStore，提供简洁的组件 API。
 */
import { useEffect, useState } from 'react';

import { useAuthStore } from '../stores/auth.js';

export function useAuth() {
  const { user, isAuthenticated, isLoading, error, login, register, logout, loadUser, clearError } =
    useAuthStore();
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('yo-auth');
    const parsed = stored ? (JSON.parse(stored) as { state?: { token?: string } }) : null;
    const hasToken = Boolean(parsed?.state?.token);

    if (hasToken && !isAuthenticated) {
      void loadUser().finally(() => setIsChecking(false));
    } else {
      setIsChecking(false);
    }
  }, []);

  return {
    user,
    isAuthenticated,
    isLoading,
    isChecking,
    error,
    login,
    register,
    logout,
    clearError,
  };
}
