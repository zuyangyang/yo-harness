import { useRef, useState } from 'react';

import type { Session } from '../../api/client.js';
import { ChatBubbleIcon, EllipsisHorizontalIcon } from '../Icons/index.js';
import { formatRelativeTime } from '../../utils/time.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { toast } from '../../stores/toast.js';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export function SessionItem({ session, isActive, onSelect, onDelete }: SessionItemProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(menuRef, () => setMenuOpen(false));

  const title = session.title ?? '(untitled)';
  const meta = session.model + ' · ' + formatRelativeTime(session.updatedAt);

  const comingSoon = (label: string) => (): void => {
    setMenuOpen(false);
    toast.info(label + '开发中');
  };

  const menuItems: MenuItem[] = [
    { id: 'rename', label: '重命名', onClick: comingSoon('重命名') },
    { id: 'pin', label: '置顶', onClick: comingSoon('置顶') },
    { id: 'archive', label: '归档', onClick: comingSoon('归档') },
    { id: 'copy', label: '复制链接', onClick: comingSoon('复制链接') },
    {
      id: 'delete',
      label: '删除',
      danger: true,
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
          <div className="session-item-title">{title}</div>
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
            {menuItems.map((item) => (
              <button
                key={item.id}
                className={
                  'session-item-dropdown__item' +
                  (item.danger ? ' session-item-dropdown__item--danger' : '')
                }
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
