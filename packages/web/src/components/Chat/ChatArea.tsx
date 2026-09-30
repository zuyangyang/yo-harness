import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { useSession } from '../../hooks/useSession.js';
import { groupEventsIntoTurns } from '../../utils/turn-grouping.js';
import { api } from '../../api/client.js';
import { filterSlashCommands } from '../../config/commands.js';
import { useSessionStore } from '../../stores/session.js';
import { TurnBlock } from './TurnBlock.js';
import { SlashMenu } from './SlashMenu.js';
import { AtMentionMenu, type MentionItem } from './AtMentionMenu.js';
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
  const sessions = useSessionStore((s) => s.sessions);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const turns = currentEvents.length > 0 ? groupEventsIntoTurns(currentEvents) : [];
  const lastTurn = turns[turns.length - 1];
  const isAgentRunning = Boolean(lastTurn && !lastTurn.endTime);

  const slashOpen = input.startsWith('/');
  const slashMatches = slashOpen ? filterSlashCommands(input) : [];

  const atIndex = input.lastIndexOf('@');
  const atQuery = atIndex >= 0 ? input.slice(atIndex + 1) : '';
  const mentionOpen = atIndex >= 0 && !atQuery.includes(' ') && !atQuery.includes('\n');

  const mentionItems = useMemo<MentionItem[]>(() => {
    const sessionItems: MentionItem[] = sessions.map((s) => ({
      id: 's-' + s.id,
      kind: 'session',
      label: s.title ?? '(untitled)',
      insert: s.title ?? '(untitled)',
    }));

    const fileSet = new Set<string>();
    for (const env of currentEvents) {
      if (env.payload.type === 'checkpoint_created') {
        for (const file of env.payload.files) fileSet.add(file);
      }
    }
    const fileItems: MentionItem[] = Array.from(fileSet).map((file) => ({
      id: 'f-' + file,
      kind: 'file',
      label: file,
      insert: file,
    }));

    return [...sessionItems, ...fileItems];
  }, [sessions, currentEvents]);

  const mentionMatches = mentionOpen
    ? mentionItems.filter((item) => item.label.toLowerCase().includes(atQuery.toLowerCase()))
    : [];

  const activeCount = slashOpen ? slashMatches.length : mentionOpen ? mentionMatches.length : 0;

  const autoGrow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, MAX_INPUT_HEIGHT) + 'px';
  };

  const handleChange = (value: string): void => {
    setInput(value);
    setMenuIndex(0);
    const el = textareaRef.current;
    if (el) autoGrow(el);
  };

  const selectCommand = (command: string): void => {
    setInput(command + ' ');
    setMenuIndex(0);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      autoGrow(el);
    }
  };

  const selectMention = (item: MentionItem): void => {
    const next = input.slice(0, atIndex) + '@' + item.insert + ' ';
    setInput(next);
    setMenuIndex(0);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      autoGrow(el);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (activeCount > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuIndex((i) => (i + 1) % activeCount);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i - 1 + activeCount) % activeCount);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (slashOpen) setInput('');
        else setInput(input.slice(0, atIndex));
        setMenuIndex(0);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        if (slashOpen) {
          const match = slashMatches[menuIndex];
          if (match) {
            e.preventDefault();
            selectCommand(match.command);
            return;
          }
        } else {
          const match = mentionMatches[menuIndex];
          if (match) {
            e.preventDefault();
            selectMention(match);
            return;
          }
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
              selectedIndex={menuIndex}
              onSelect={selectCommand}
              onHover={setMenuIndex}
            />
          ) : mentionOpen ? (
            <AtMentionMenu
              items={mentionMatches}
              selectedIndex={menuIndex}
              onSelect={selectMention}
              onHover={setMenuIndex}
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
