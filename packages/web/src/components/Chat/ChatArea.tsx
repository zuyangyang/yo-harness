/**
 * 消息列表 + 输入框。
 */
import { useState, type FormEvent } from 'react';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { useSession } from '../../hooks/useSession.js';
import { MessageBubble } from './MessageBubble.js';

export function ChatArea(): JSX.Element {
  const { currentSession, currentEvents, sendMessage } = useSession();
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isSending) return;

    setInput('');
    setIsSending(true);
    try {
      await sendMessage(text);
    } finally {
      setIsSending(false);
    }
  };

  if (!currentSession) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
        Select or create a session to start
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: 15, borderBottom: '1px solid #e0e0e0', background: '#fff' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{currentSession.title ?? '(untitled)'}</h2>
        <div style={{ fontSize: 12, color: '#666' }}>
          {currentSession.model} · {currentSession.cwd}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 20, background: '#fafafa' }}>
        {currentEvents.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#999', marginTop: 50 }}>
            Start a conversation by sending a message
          </div>
        ) : (
          currentEvents.map((envelope) => (
            <MessageBubble key={envelope.id} envelope={envelope} />
          ))
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        style={{ padding: 15, borderTop: '1px solid #e0e0e0', background: '#fff' }}
      >
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            disabled={isSending}
            style={{
              flex: 1,
              padding: 10,
              border: '1px solid #ddd',
              borderRadius: 4,
              fontSize: 14,
            }}
          />
          <button
            type="submit"
            disabled={isSending || !input.trim()}
            style={{
              padding: '10px 20px',
              background: '#007bff',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: isSending || !input.trim() ? 'not-allowed' : 'pointer',
              fontSize: 14,
            }}
          >
            {isSending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
