import type { Session } from '../../api/client.js';
import { ChatBubbleIcon } from '../Icons/index.js';
import { formatRelativeTime } from '../../utils/time.js';

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function SessionItem({ session, isActive, onSelect, onDelete }: SessionItemProps): JSX.Element {
  const title = session.title ?? '(untitled)';
  const meta = session.model + ' · ' + formatRelativeTime(session.updatedAt);

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
      <button
        className="session-item-delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete session"
        aria-label="删除会话"
      >
        ×
      </button>
    </div>
  );
}
