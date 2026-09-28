/**
 * 会话条目。
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
      onClick={onSelect}
      style={{
        padding: 12,
        borderBottom: '1px solid #e0e0e0',
        cursor: 'pointer',
        background: isActive ? '#e7f3ff' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>{title}</div>
          <div style={{ fontSize: 11, color: '#666' }}>
            {session.model} · {updatedAt}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            padding: '2px 6px',
            background: 'none',
            border: 'none',
            color: '#999',
            cursor: 'pointer',
            fontSize: 14,
          }}
          title="Delete session"
        >
          ×
        </button>
      </div>
    </div>
  );
}
