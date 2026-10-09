/**
 * 顶部通知铃铛：未读数 + 通知下拉。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useNotificationStore } from '../../stores/notifications.js';
import { useSessionStore } from '../../stores/session.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { IconButton } from '../ui/IconButton.js';
import { BellIcon } from '../Icons/index.js';

export function NotificationBell(): JSX.Element {
  const notifications = useNotificationStore((s) => s.notifications);
  const unread = useNotificationStore((s) => s.unread);
  const load = useNotificationStore((s) => s.load);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const selectSession = useSessionStore((s) => s.selectSession);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useClickOutside(ref, () => setOpen(false));

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="notification-bell" ref={ref}>
      <IconButton label="通知" active={open} onClick={() => setOpen((v) => !v)}>
        <BellIcon className="icon-svg" />
      </IconButton>
      {unread > 0 ? (
        <span className="notification-bell__badge">{unread > 99 ? '99+' : unread}</span>
      ) : null}
      {open ? (
        <div className="notification-bell__dropdown">
          <div className="notification-bell__header">
            <span>通知</span>
            <button className="btn btn-sm btn-secondary" onClick={() => void markAllRead()}>
              全部已读
            </button>
          </div>
          {notifications.length === 0 ? (
            <p className="notification-bell__empty">暂无通知</p>
          ) : (
            <ul className="notification-bell__list">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={
                    'notification-bell__item' + (n.readAt === null ? ' notification-bell__item--unread' : '')
                  }
                >
                  <button
                    className="notification-bell__button"
                    onClick={() => {
                      void markRead(n.id);
                      if (n.sessionId !== null) {
                        void selectSession(n.sessionId);
                        void navigate('/chat');
                      }
                      setOpen(false);
                    }}
                  >
                    <span className="notification-bell__title">{n.title}</span>
                    {n.body !== null ? <span className="notification-bell__body">{n.body}</span> : null}
                    <span className="notification-bell__time">{new Date(n.createdAt).toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
