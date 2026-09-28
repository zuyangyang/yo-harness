/**
 * yo-harness Web UI 根组件：路由 + 认证守卫。
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { useAuth } from './hooks/useAuth.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { LoginPage } from './pages/LoginPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { MainLayout } from './components/MainLayout.js';

function ProtectedRoute({ children }: { children: JSX.Element }): JSX.Element {
  const { isAuthenticated } = useAuth();
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
          path="/*"
          element={
            <ProtectedRoute>
              <WebSocketProvider>
                <MainLayout />
              </WebSocketProvider>
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
