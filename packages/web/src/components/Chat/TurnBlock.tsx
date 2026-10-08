/**
 * TurnBlock: container for one complete turn (user message + agent response).
 * Composes UserMessage + ThinkingSection + ToolSteps + FinalReply + TurnMeta.
 *
 * 生成中的状态：`isRunning` 为真时，若已有流式增量则渐进渲染回复正文并显示
 * 光标；否则显示「正在生成…」等待动画。assistant_text 提交后由事件流渲染完整
 * 正文，避免与流式缓冲重复。
 */
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { Turn } from '../../utils/turn-grouping.js';
import { ThinkingSection } from './ThinkingSection.js';
import { ToolSteps } from './ToolSteps.js';
import { MessageActions } from './MessageActions.js';
import { Button } from '../ui/Button.js';

interface TurnBlockProps {
  turn: Turn;
  /** 尚未提交的 LLM 流式文本增量 */
  streamingText?: string;
  /** 本轮是否仍在生成中 */
  isRunning?: boolean;
  /** turn 未记录模型时的回退（会话级 / 全局默认模型） */
  fallbackModel?: string;
  /** 重新生成本轮：回退并重发 user 消息原文 */
  onRetry?: (() => void) | undefined;
  /** 编辑本轮 user 消息并重发；成功后关闭编辑态，失败时保留以便修改 */
  onEdit?: ((content: string) => Promise<void>) | undefined;
}

export function TurnBlock({
  turn,
  streamingText = '',
  isRunning = false,
  fallbackModel,
  onRetry,
  onEdit,
}: TurnBlockProps): JSX.Element {
  const durationMs = calculateDuration(turn);
  const showStreaming = isRunning && streamingText.length > 0;
  const showWaiting = isRunning && turn.finalText.length === 0 && !showStreaming;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const startEdit = (): void => {
    setDraft(turn.userMessage);
    setEditing(true);
  };

  const cancelEdit = (): void => {
    if (submitting) return;
    setEditing(false);
  };

  const submitEdit = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || submitting) return;
    setSubmitting(true);
    try {
      await onEdit?.(text);
      setEditing(false);
    } catch {
      // 失败提示由外层负责；保留编辑态，用户可修改后重试
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="turn-block">
      <div className="message-row message-row--user">
        {editing ? (
          <div className="message-edit">
            <textarea
              className="message-edit__input"
              aria-label="编辑消息"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitEdit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              autoFocus
            />
            <div className="message-edit__actions">
              <Button
                variant="primary"
                size="sm"
                type="button"
                disabled={submitting || draft.trim() === ''}
                onClick={() => { void submitEdit(); }}
              >
                保存并重新发送
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={submitting}
                onClick={cancelEdit}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <div className="message-bubble message-bubble--user">
            {turn.userMessage}
          </div>
        )}
      </div>

      {turn.errors.length > 0 && (
        <div className="message-row">
          <div className="message-bubble message-bubble--error">
            {turn.errors.map((err, idx) => (
              <div key={idx}>
                <strong>Error ({err.stage}):</strong> {err.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {turn.thinkingTexts.length > 0 && (
        <ThinkingSection
          texts={turn.thinkingTexts}
          toolCount={turn.toolSteps.length}
          durationMs={durationMs}
        />
      )}

      {turn.toolSteps.length > 0 && <ToolSteps steps={turn.toolSteps} />}

      {turn.finalText.length > 0 && (
        <>
          <div className="message-row message-row--assistant">
            <div className="message-bubble message-bubble--assistant turn-reply">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.finalText}</ReactMarkdown>
            </div>
          </div>
          {!isRunning && (
            <MessageActions
              text={turn.finalText}
              onRetry={onRetry}
              onEdit={onEdit !== undefined ? startEdit : undefined}
              disabled={submitting}
            />
          )}
        </>
      )}

      {showStreaming && (
        <div className="message-row message-row--assistant">
          <div className="message-bubble message-bubble--assistant turn-reply turn-reply--streaming">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
            <span className="stream-cursor" aria-hidden="true" />
          </div>
        </div>
      )}

      {showWaiting && <TurnWaiting />}

      <TurnMeta
        turn={turn}
        durationMs={durationMs}
        fallbackModel={fallbackModel}
      />
    </div>
  );
}

/** 「正在生成 / 等待中」动画；流式文本尚未到达或工具执行期间展示 */
export function TurnWaiting(): JSX.Element {
  return (
    <div className="message-row message-row--assistant">
      <div className="turn-waiting" role="status" aria-live="polite">
        <span className="turn-waiting__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="turn-waiting__label">正在生成…</span>
      </div>
    </div>
  );
}

function TurnMeta({
  turn,
  durationMs,
  fallbackModel,
}: {
  turn: Turn;
  durationMs?: number;
  fallbackModel?: string;
}): JSX.Element | null {
  const parts: string[] = [];

  if (turn.toolSteps.length > 0) {
    parts.push(`${turn.toolSteps.length} step${turn.toolSteps.length > 1 ? 's' : ''}`);
  }

  if (durationMs !== undefined) {
    parts.push(formatDuration(durationMs));
  }

  if (turn.usage) {
    const totalTokens = turn.usage.inputTokens + turn.usage.outputTokens;
    if (totalTokens > 0) {
      parts.push(formatTokens(totalTokens));
    }
  }

  const model = turn.model ?? fallbackModel;
  const hasChips = turn.meta.length > 0;
  if (parts.length === 0 && !hasChips && model === undefined) return null;

  return (
    <div className="turn-meta-wrap">
      {hasChips && (
        <div className="turn-chips">
          {turn.meta.map((m) => (
            <span key={m.key} className={'turn-chip turn-chip--' + m.kind} title={m.detail}>
              {m.label}
            </span>
          ))}
        </div>
      )}
      {model !== undefined && model !== '' ? (
        <div className="turn-meta">
          <span className="turn-meta__model" title={'模型：' + model}>
            {model}
          </span>
          {parts.length > 0 && <span className="turn-meta__sep"> · </span>}
          {parts.join(' · ')}
        </div>
      ) : parts.length > 0 ? (
        <div className="turn-meta">{parts.join(' · ')}</div>
      ) : null}
    </div>
  );
}

function calculateDuration(turn: Turn): number | undefined {
  if (!turn.endTime) return undefined;
  const start = new Date(turn.startTime).getTime();
  const end = new Date(turn.endTime).getTime();
  return end - start;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  return `${(tokens / 1000).toFixed(1)}k tokens`;
}
