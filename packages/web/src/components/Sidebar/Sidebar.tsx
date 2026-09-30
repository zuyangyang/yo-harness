import { useSession } from '../../hooks/useSession.js';
import { useAuth } from '../../hooks/useAuth.js';
import { SessionItem } from './SessionItem.js';
import { CogIcon, ArrowRightOnRectangleIcon } from '../Icons/index.js';

interface SidebarProps {
  onNewSession: () => void;
}

export function Sidebar({ onNewSession }: SidebarProps): JSX.Element {
  const { sessions, currentSessionId, selectSession, deleteSession } = useSession();
  const { user, logout } = useAuth();

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="btn btn-primary sidebar-new-btn" onClick={onNewSession}>
          <span>+</span> New Session
        </button>
      </div>
      <div className="sidebar-list">
        {sessions.length === 0 ? (
          <div className="sidebar-empty">No sessions yet</div>
        ) : (
          sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === currentSessionId}
              onSelect={() => { void selectSession(session.id); }}
              onDelete={() => { void deleteSession(session.id); }}
            />
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <span className="sidebar-username">{user?.username ?? 'Unknown'}</span>
          <div className="sidebar-footer-actions">
            <button className="sidebar-footer-btn" title="Settings"><CogIcon className="icon-footer" /></button>
            <button className="sidebar-logout-btn" onClick={logout} title="Logout"><ArrowRightOnRectangleIcon className="icon-footer" /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
