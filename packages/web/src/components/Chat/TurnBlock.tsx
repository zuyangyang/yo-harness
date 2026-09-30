/**
 * TurnBlock: container for one complete turn (user message + agent response).
 * Composes UserMessage + ThinkingSection + ToolSteps + FinalReply + TurnMeta.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { Turn } from '../../utils/turn-grouping.js';
import { ThinkingSection } from './ThinkingSection.js';
import { ToolSteps } from './ToolSteps.js';
import { MessageActions } from './MessageActions.js';

interface TurnBlockProps {
  turn: Turn;
}

export function TurnBlock({ turn }: TurnBlockProps): JSX.Element {
  const durationMs = calculateDuration(turn);

  return (
    <div className="turn-block">
      <div className="message-row message-row--user">
        <div className="message-bubble message-bubble--user">
          {turn.userMessage}
        </div>
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

      {turn.finalText && (
        <>
          <div className="message-row message-row--assistant">
            <div className="message-bubble message-bubble--assistant turn-reply">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.finalText}</ReactMarkdown>
            </div>
          </div>
          <MessageActions text={turn.finalText} />
        </>
      )}

      <TurnMeta turn={turn} durationMs={durationMs} />
    </div>
  );
}

function TurnMeta({ turn, durationMs }: { turn: Turn; durationMs?: number }): JSX.Element | null {
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

  const hasChips = turn.meta.length > 0;
  if (parts.length === 0 && !hasChips) return null;

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
      {parts.length > 0 && <div className="turn-meta">{parts.join(' · ')}</div>}
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
