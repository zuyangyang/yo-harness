/**
 * 会话 hook：封装 useSessionStore，提供简洁的组件 API。
 */
import { useEffect } from 'react';

import { useSessionStore } from '../stores/session.js';

export function useSession() {
  const {
    sessions,
    currentSessionId,
    events,
    isLoading,
    error,
    loadSessions,
    selectSession,
    createSession,
    updateSession,
    renameSession,
    togglePin,
    archiveSession,
    moveSession,
    deleteSession,
    sendMessage,
    clearError,
  } = useSessionStore();

  useEffect(() => {
    void loadSessions();
  }, []);

  const currentSession = sessions.find((s) => s.id === currentSessionId) ?? null;
  const currentEvents = currentSessionId ? (events.get(currentSessionId) ?? []) : [];

  return {
    sessions,
    currentSession,
    currentSessionId,
    currentEvents,
    isLoading,
    error,
    selectSession,
    createSession,
    updateSession,
    renameSession,
    togglePin,
    archiveSession,
    moveSession,
    deleteSession,
    sendMessage,
    clearError,
  };
}
