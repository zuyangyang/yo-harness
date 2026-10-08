/**
 * Sidebar 组件测试：会话选中后跳转对话视图；底部不再重复设置/退出入口。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../../src/components/Sidebar/Sidebar.js';
import { useAuthStore } from '../../src/stores/auth.js';
import { useSessionStore } from '../../src/stores/session.js';
import { useWorkspaceStore } from '../../src/stores/workspace.js';
import type { Session } from '../../src/api/client.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const SESSION: Session = {
  id: 's1',
  title: 'hello test',
  model: 'wlyd-llm/deepseek-v4.1-flash',
  cwd: '/tmp',
  status: 'active',
  type: 'interactive',
  workspaceId: null,
  pinned: false,
  titleIsCustom: true,
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
};

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/settings"
          element={
            <>
              <Sidebar onNewSession={() => undefined} />
              <div>SETTINGS_SCREEN</div>
            </>
          }
        />
        <Route
          path="/chat"
          element={
            <>
              <Sidebar onNewSession={() => undefined} />
              <div>CHAT_SCREEN</div>
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes('/events')) return Promise.resolve(jsonResponse({ events: [] }));
      if (url.includes('/api/v1/sessions')) return Promise.resolve(jsonResponse({ sessions: [SESSION] }));
      if (url.includes('/api/v1/workspaces')) return Promise.resolve(jsonResponse({ workspaces: [] }));
      return Promise.resolve(jsonResponse({}));
    }),
  );

  useAuthStore.setState({
    user: { id: 'u1', username: 'yangyang', role: 'member' },
    isAuthenticated: true,
  });
  useSessionStore.setState({
    sessions: [SESSION],
    currentSessionId: null,
    events: new Map(),
    isLoading: false,
    error: null,
  });
  useWorkspaceStore.setState({ workspaces: [], isLoading: false, error: null });
});

describe('Sidebar', () => {
  it('点击会话后跳转到对话视图', () => {
    renderAt('/settings');
    expect(screen.getByText('SETTINGS_SCREEN')).toBeTruthy();

    fireEvent.click(screen.getByText('hello test'));

    expect(screen.getByText('CHAT_SCREEN')).toBeTruthy();
    expect(screen.queryByText('SETTINGS_SCREEN')).toBeNull();
  });

  it('底部不再重复提供设置与退出登录入口（由左侧 NavRail 统一管理）', () => {
    renderAt('/chat');

    expect(screen.getByText('yangyang')).toBeTruthy();
    expect(screen.queryByTitle('Settings')).toBeNull();
    expect(screen.queryByTitle('Logout')).toBeNull();
  });
});
