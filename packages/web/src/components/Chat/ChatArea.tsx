/**
 * Chat area: message list + input form.
 */
import { useState, type FormEvent } from 'react';

import { useSession } from '../../hooks/useSession.js';
import { groupEventsIntoTurns } from '../../utils/turn-grouping.js';
import { TurnBlock } from './TurnBlock.js';

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
      <div className="chat-empty">
        <div className="chat-empty-icon"></div>
        <div className="chat-empty-text">Select or create a session to start</div>
      </div>
    );
  }

  return (
    <div className="chat-area">
      <div className="chat-header">
        <h2 className="chat-title">{currentSession.title ?? '(untitled)'}</h2>
        <div className="chat-meta">
          {currentSession.model} · {currentSession.cwd}
        </div>
      </div>

      <div className="chat-messages">
        {currentEvents.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">✨</div>
            <div className="chat-empty-text">Start a conversation by sending a message</div>
          </div>
        ) : (
          (() => {
            const turns = groupEventsIntoTurns(currentEvents);
            return turns.map((turn) => <TurnBlock key={turn.id} turn={turn} />);
          })()
        )}
      </div>

      <div className="chat-input-area">
        <form className="chat-input-form" onSubmit={handleSubmit}>
          <input
            className="chat-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            disabled={isSending}
          />
          <button
            className="chat-send-btn"
            type="submit"
            disabled={isSending || !input.trim()}
          >
            {isSending ? 'Sending...' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  );
}
