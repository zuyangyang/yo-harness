import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { useSession } from '../../hooks/useSession.js';
import { groupEventsIntoTurns } from '../../utils/turn-grouping.js';
import { api } from '../../api/client.js';
import { filterSlashCommands } from '../../config/commands.js';
import { TurnBlock } from './TurnBlock.js';
import { SlashMenu } from './SlashMenu.js';
import { ModelSelector } from '../Model/ModelSelector.js';
import { IconButton } from '../ui/IconButton.js';
import { toast } from '../../stores/toast.js';
import {
  SparklesIcon,
  ArrowUpIcon,
  StopIcon,
  ChatBubbleIcon,
  PaperClipIcon,
  MicrophoneIcon,
} from '../Icons/index.js';

interface ChatAreaProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
}

const MAX_INPUT_HEIGHT = 240;

export function ChatArea({ selectedModel, onModelChange }: ChatAreaProps): JSX.Element {
  const { currentSession, currentEvents, sendMessage } = useSession();
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const turns = currentEvents.length > 0 ? groupEventsIntoTurns(currentEvents) : [];
  const lastTurn = turns[turns.length - 1];
  const isAgentRunning = Boolean(lastTurn && !lastTurn.endTime);

  const slashOpen = input.startsWith('/');
  const slashMatches = slashOpen ? filterSlashCommands(input) : [];

  const autoGrow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
  };

  const handleChange = (value: string): void => {
    setInput(value);
    setSlashIndex(0);
    const el = textareaRef.current;
    if (el) autoGrow(el);
  };

  const selectCommand = (command: string): void => {
    setInput(command + ' ');
    setSlashIndex(0);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      autoGrow(el);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInput('');
        setSlashIndex(0);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const match = slashMatches[slashIndex];
        if (match) {
          e.preventDefault();
          selectCommand(match.command);
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const form = e.currentTarget.form;
      if (form) form.requestSubmit();
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isSending) return;

    setInput('');
    setIsSending(true);
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
    }
    try {
      await sendMessage(text);
    } finally {
      setIsSending(false);
    }
  };

  const handleInterrupt = async (): Promise<void> => {
    if (!currentSession) return;
    try {
      await api.sessions.interrupt(currentSession.id);
      toast.info('已发送中断请求');
    } catch {
      toast.error('中断失败');
    }
  };

  if (!currentSession) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-icon">
          <ChatBubbleIcon className="icon-empty" />
        </div>
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
        {turns.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <SparklesIcon className="icon-empty" />
            </div>
            <div className="chat-empty-text">Start a conversation by sending a message</div>
          </div>
        ) : (
          turns.map((turn) => <TurnBlock key={turn.id} turn={turn} />)
        )}
      </div>

      <div className="chat-input-area">
        <div className="chat-composer">
          {slashOpen ? (
            <SlashMenu
              query={input}
              selectedIndex={slashIndex}
              onSelect={selectCommand}
              onHover={setSlashIndex}
            />
          ) : null}

          <form className="chat-input-form" onSubmit={(e) => { void handleSubmit(e); }}>
            <IconButton label="添加附件" size="sm" onClick={() => toast.info('附件上传开发中')}>
              <PaperClipIcon className="icon-svg" />
            </IconButton>
            <IconButton label="语音输入" size="sm" onClick={() => toast.info('语音输入开发中')}>
              <MicrophoneIcon className="icon-svg" />
            </IconButton>

            <textarea
              ref={textareaRef}
              className="chat-input"
              value={input}
              onChange={(e) => handleChange(e.target.value)}
              placeholder="发消息或创建任务，/ 调用指令，@ 文件或对话"
              disabled={isSending}
              rows={1}
              onKeyDown={handleKeyDown}
            />

            <div className="chat-input-right">
              <ModelSelector value={selectedModel} onChange={onModelChange} />
              {isAgentRunning ? (
                <button
                  className="chat-stop-btn"
                  type="button"
                  onClick={() => { void handleInterrupt(); }}
                  title="停止"
                >
                  <StopIcon className="icon-send" />
                </button>
              ) : (
                <button
                  className="chat-send-btn"
                  type="submit"
                  disabled={isSending || !input.trim()}
                  title="Send"
                >
                  <ArrowUpIcon className="icon-send" />
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
