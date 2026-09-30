import { useEffect, useMemo, useRef, useState } from 'react';

import { useSession } from '../../hooks/useSession.js';
import { useAuth } from '../../hooks/useAuth.js';
import { useWorkspaceStore } from '../../stores/workspace.js';
import type { Workspace } from '../../api/client.js';
import { SessionItem } from './SessionItem.js';
import { WorkspaceDialog } from './WorkspaceDialog.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import {
  CogIcon,
  ArrowRightOnRectangleIcon,
  SearchIcon,
  PlusIcon,
  EllipsisHorizontalIcon,
} from '../Icons/index.js';

interface SidebarProps {
  onNewSession: (workspaceId?: string | null) => void;
}

type DialogState = { mode: 'create' } | { mode: 'rename'; workspace: Workspace } | null;

export function Sidebar({ onNewSession }: SidebarProps): JSX.Element {
  const {
    sessions,
    currentSessionId,
    selectSession,
    deleteSession,
    renameSession,
    togglePin,
    updateSession,
    moveSession,
  } = useSession();
  const {
    workspaces,
    loadWorkspaces,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
  } = useWorkspaceStore();
  const { user, logout } = useAuth();

  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [openWsMenu, setOpenWsMenu] = useState<string | null>(null);
  const wsMenuRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(wsMenuRef, () => setOpenWsMenu(null));

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  const knownIds = useMemo(() => new Set(workspaces.map((w) => w.id)), [workspaces]);
  const standalone = useMemo(
    () => filtered.filter((s) => s.workspaceId === null || (s.workspaceId !== null && !knownIds.has(s.workspaceId))),
    [filtered, knownIds],
  );
  const sections = useMemo(
    () => workspaces.map((ws) => ({ ws, sessions: filtered.filter((s) => s.workspaceId === ws.id) })),
    [workspaces, filtered],
  );

  const renderSession = (session: (typeof sessions)[number]): JSX.Element => (
    <SessionItem
      key={session.id}
      session={session}
      workspaces={workspaces}
      isActive={session.id === currentSessionId}
      onSelect={() => {
        void selectSession(session.id);
      }}
      onRename={(title) => {
        void renameSession(session.id, title);
      }}
      onTogglePin={() => {
        void togglePin(session.id, !session.pinned);
      }}
      onToggleArchive={() => {
        void updateSession(session.id, { status: session.status === 'active' ? 'archived' : 'active' });
      }}
      onMove={(workspaceId) => {
        void moveSession(session.id, workspaceId);
      }}
      onDelete={() => {
        void deleteSession(session.id);
      }}
    />
  );

  const handleDeleteWorkspace = (ws: Workspace): void => {
    if (window.confirm(`删除工作区“${ws.name}”？其下的会话将解绑为独立会话。`)) {
      void deleteWorkspace(ws.id);
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="btn btn-primary sidebar-new-btn" onClick={() => onNewSession()}>
          <span>+</span> New Session
        </button>
        <div className="sidebar-search">
          <SearchIcon className="icon-svg" />
          <input
            type="text"
            placeholder="搜索会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索会话"
          />
        </div>
      </div>
      <div className="sidebar-list">
        {standalone.length === 0 && sections.every((s) => s.sessions.length === 0) ? (
          <div className="sidebar-empty">No sessions yet</div>
        ) : null}

        {standalone.length > 0 ? (
          <div className="session-group">
            <div className="session-group__label">会话</div>
            {standalone.map(renderSession)}
          </div>
        ) : null}

        {sections.map(({ ws, sessions: wsSessions }) => (
          <div key={ws.id} className="session-group">
            <div className="workspace-header">
              <div className="workspace-header__title">
                <span className="workspace-header__dot" style={ws.color ? { background: ws.color } : undefined} />
                <span className="workspace-header__name">{ws.name}</span>
                <span className="workspace-header__count">{wsSessions.length}</span>
              </div>
              <div className="workspace-header__actions">
                <button
                  className="workspace-header__btn"
                  title="在该工作区新建会话"
                  aria-label={`在 ${ws.name} 新建会话`}
                  onClick={() => onNewSession(ws.id)}
                >
                  <PlusIcon className="icon-svg" />
                </button>
                <button
                  className="workspace-header__btn"
                  title="工作区操作"
                  aria-label={`${ws.name} 操作`}
                  aria-haspopup="menu"
                  aria-expanded={openWsMenu === ws.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenWsMenu((v) => (v === ws.id ? null : ws.id));
                  }}
                >
                  <EllipsisHorizontalIcon className="icon-svg" />
                </button>
              </div>
              {openWsMenu === ws.id ? (
                <div className="workspace-header__dropdown" role="menu" ref={wsMenuRef}>
                  <button
                    className="session-item-dropdown__item"
                    role="menuitem"
                    onClick={() => {
                      setOpenWsMenu(null);
                      setDialog({ mode: 'rename', workspace: ws });
                    }}
                  >
                    重命名
                  </button>
                  <button
                    className="session-item-dropdown__item session-item-dropdown__item--danger"
                    role="menuitem"
                    onClick={() => {
                      setOpenWsMenu(null);
                      handleDeleteWorkspace(ws);
                    }}
                  >
                    删除
                  </button>
                </div>
              ) : null}
            </div>
            {wsSessions.map(renderSession)}
          </div>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-footer__row">
          <button className="workspace-new-btn" onClick={() => setDialog({ mode: 'create' })}>
            <PlusIcon className="icon-svg" /> 新建工作区
          </button>
        </div>
        <div className="sidebar-user">
          <span className="sidebar-username">{user?.username ?? 'Unknown'}</span>
          <div className="sidebar-footer-actions">
            <button className="sidebar-footer-btn" title="Settings">
              <CogIcon className="icon-footer" />
            </button>
            <button className="sidebar-logout-btn" onClick={logout} title="Logout">
              <ArrowRightOnRectangleIcon className="icon-footer" />
            </button>
          </div>
        </div>
      </div>

      {dialog !== null ? (
        <WorkspaceDialog
          title={dialog.mode === 'create' ? '新建工作区' : '重命名工作区'}
          submitLabel={dialog.mode === 'create' ? '创建' : '保存'}
          initialName={dialog.mode === 'rename' ? dialog.workspace.name : ''}
          onSubmit={async (name) => {
            if (dialog.mode === 'create') {
              await createWorkspace({ name });
            } else {
              await updateWorkspace(dialog.workspace.id, { name });
            }
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
