/**
 * yo-harness Web UI 根组件：路由 + 认证守卫。
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { useAuth } from './hooks/useAuth.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { AppShell } from './layout/AppShell.js';
import { ChatView } from './features/chat/ChatView.js';
import { TasksView } from './features/tasks/TasksView.js';
import { MemoryView } from './features/memory/MemoryView.js';
import { ArtifactsView } from './features/artifacts/ArtifactsView.js';
import { SettingsView } from './features/settings/SettingsView.js';
import { ToastHost } from './components/ui/Toast.js';

function ProtectedRoute({ children }: { children: JSX.Element }): JSX.Element {
  const { isAuthenticated, isChecking } = useAuth();
  if (isChecking) {
    return <div className="app-loading">Loading...</div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function WebSocketProvider({ children }: { children: JSX.Element }): JSX.Element {
  useWebSocket();
  return children;
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          element={
            <ProtectedRoute>
              <WebSocketProvider>
                <AppShell />
              </WebSocketProvider>
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="chat" element={<ChatView />} />
          <Route path="tasks" element={<TasksView />} />
          <Route path="memory" element={<MemoryView />} />
          <Route path="artifacts" element={<ArtifactsView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Route>
      </Routes>
      <ToastHost />
    </BrowserRouter>
  );
}
