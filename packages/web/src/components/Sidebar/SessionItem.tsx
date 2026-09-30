import { useRef, useState } from 'react';

import type { Session, Workspace } from '../../api/client.js';
import { ChatBubbleIcon, EllipsisHorizontalIcon, PinIcon } from '../Icons/index.js';
import { formatRelativeTime } from '../../utils/time.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';

interface SessionItemProps {
  session: Session;
  workspaces: Workspace[];
  isActive: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onMove: (workspaceId: string | null) => void;
  onDelete: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  dividerBefore?: boolean;
  header?: boolean;
  onClick?: () => void;
}

export function SessionItem({
  session,
  workspaces,
  isActive,
  onSelect,
  onRename,
  onTogglePin,
  onToggleArchive,
  onMove,
  onDelete,
}: SessionItemProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(menuRef, () => setMenuOpen(false));

  const title = session.title === '' ? '(untitled)' : session.title;
  const meta = session.model + ' · ' + formatRelativeTime(session.updatedAt);

  const commitRename = (): void => {
    setEditing(false);
    const next = draft.trim();
    if (next !== '' && next !== session.title) {
      onRename(next);
    } else {
      setDraft(session.title);
    }
  };

  const items: MenuItem[] = [
    { id: 'rename', label: '重命名', onClick: () => {
      setMenuOpen(false);
      setDraft(session.title);
      setEditing(true);
    } },
    {
      id: 'pin',
      label: session.pinned ? '取消置顶' : '置顶',
      onClick: () => {
        setMenuOpen(false);
        onTogglePin();
      },
    },
    {
      id: 'archive',
      label: session.status === 'archived' ? '恢复会话' : '归档',
      onClick: () => {
        setMenuOpen(false);
        onToggleArchive();
      },
    },
    { id: 'move-header', label: '移动到工作区', header: true, dividerBefore: true },
    { id: 'move-none', label: '独立会话（无工作区）', onClick: () => {
      setMenuOpen(false);
      onMove(null);
    } },
    ...workspaces.map((ws) => ({
      id: 'move-' + ws.id,
      label: ws.name,
      onClick: () => {
        setMenuOpen(false);
        onMove(ws.id);
      },
    })),
    {
      id: 'delete',
      label: '删除',
      danger: true,
      dividerBefore: true,
      onClick: () => {
        setMenuOpen(false);
        onDelete();
      },
    },
  ];

  return (
    <div
      className={'session-item' + (isActive ? ' session-item--active' : '')}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="session-item-content">
        <div className="session-item-icon">
          <ChatBubbleIcon className="icon-session" />
        </div>
        <div className="session-item-info">
          {editing ? (
            <input
              className="session-item-rename-input"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') {
                  setDraft(session.title);
                  setEditing(false);
                }
              }}
              aria-label="会话名称"
            />
          ) : (
            <div className="session-item-title">
              {session.pinned ? <PinIcon className="session-item-pin" /> : null}
              <span className="session-item-title__text">{title}</span>
            </div>
          )}
          <div className="session-item-meta">{meta}</div>
        </div>
      </div>

      <div className="session-item-menu" ref={menuRef}>
        <button
          className="session-item-menu-btn"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="会话操作"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <EllipsisHorizontalIcon className="icon-svg" />
        </button>
        {menuOpen ? (
          <div className="session-item-dropdown" role="menu">
            {items.map((item) => {
              if (item.header) {
                return (
                  <div key={item.id} className={'session-item-dropdown__header' + (item.dividerBefore ? ' session-item-dropdown__divider' : '')}>
                    {item.label}
                  </div>
                );
              }
              return (
                <button
                  key={item.id}
                  className={
                    'session-item-dropdown__item' +
                    (item.danger ? ' session-item-dropdown__item--danger' : '') +
                    (item.dividerBefore ? ' session-item-dropdown__divider' : '')
                  }
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    item.onClick?.();
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
