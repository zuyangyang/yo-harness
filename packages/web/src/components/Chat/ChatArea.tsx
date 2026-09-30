import { useState, type FormEvent } from 'react';

import { useSession } from '../../hooks/useSession.js';
import { groupEventsIntoTurns } from '../../utils/turn-grouping.js';
import { TurnBlock } from './TurnBlock.js';
import { ModelSelector } from '../Model/ModelSelector.js';
import { SparklesIcon, ArrowUpIcon, ChatBubbleIcon } from '../Icons/index.js';

interface ChatAreaProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
}

export function ChatArea({ selectedModel, onModelChange }: ChatAreaProps): JSX.Element {
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
        <div className="chat-empty-icon"><ChatBubbleIcon className="icon-empty" /></div>
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
            <div className="chat-empty-icon"><SparklesIcon className="icon-empty" /></div>
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
          <button type="button" className="chat-input-plus" title="Add">+</button>
          <textarea
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="发消息或创建任务，/ 调用指令，@ 文件或对话"
            disabled={isSending}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const form = e.currentTarget.form;
                if (form) form.requestSubmit();
              }
            }}
          />
          <div className="chat-input-right">
            <ModelSelector value={selectedModel} onChange={onModelChange} />
            <button
              className="chat-send-btn"
              type="submit"
              disabled={isSending || !input.trim()}
              title="Send"
            >
              <ArrowUpIcon className="icon-send" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
