/**
 * 会话列表侧边栏。
 */
import { useSession } from '../../hooks/useSession.js';
import { useAuth } from '../../hooks/useAuth.js';
import { SessionItem } from './SessionItem.js';

export function Sidebar(): JSX.Element {
  const { sessions, currentSessionId, selectSession, createSession, deleteSession } = useSession();
  const { user, logout } = useAuth();

  const handleNewSession = async (): Promise<void> => {
    try {
      const session = await createSession(undefined, process.cwd());
      await selectSession(session.id);
    } catch {
      // Error is handled by session store
    }
  };

  return (
    <div
      style={{
        width: 280,
        height: '100vh',
        borderRight: '1px solid #e0e0e0',
        display: 'flex',
        flexDirection: 'column',
        background: '#f9f9f9',
      }}
    >
      <div style={{ padding: 15, borderBottom: '1px solid #e0e0e0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Sessions</h2>
          <button
            onClick={handleNewSession}
            style={{
              padding: '5px 10px',
              background: '#007bff',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            + New
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {sessions.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>No sessions yet</div>
        ) : (
          sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={session.id === currentSessionId}
              onSelect={() => selectSession(session.id)}
              onDelete={() => deleteSession(session.id)}
            />
          ))
        )}
      </div>

      <div style={{ padding: 15, borderTop: '1px solid #e0e0e0', fontSize: 12 }}>
        <div style={{ marginBottom: 5 }}>
          <strong>{user?.username ?? 'Unknown'}</strong>
        </div>
        <button
          onClick={logout}
          style={{
            padding: '5px 10px',
            background: '#dc3545',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Logout
        </button>
      </div>
    </div>
  );
}
