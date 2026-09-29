/**
 * Session item in sidebar.
 */
import type { Session } from '../../api/client.js';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, isActive, onSelect, onDelete }: SessionItemProps): JSX.Element {
  const title = session.title ?? '(untitled)';
  const updatedAt = new Date(session.updatedAt).toLocaleDateString();

  return (
    <div
      className={`session-item ${isActive ? 'session-item--active' : ''}`}
      onClick={onSelect}
    >
      <div className="session-item-content">
        <div className="session-item-icon">💬</div>
        <div className="session-item-info">
          <div className="session-item-title">{title}</div>
          <div className="session-item-meta">
            {session.model} · {updatedAt}
          </div>
        </div>
      </div>
      <button
        className="session-item-delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete session"
      >
        ×
      </button>
    </div>
  );
}
