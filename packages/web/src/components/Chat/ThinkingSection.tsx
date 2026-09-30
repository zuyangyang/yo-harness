/**
 * ThinkingSection: collapsible display of assistant reasoning/thinking text.
 */
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRightIcon } from '../Icons/index.js';

interface ThinkingSectionProps {
  texts: string[];
  toolCount: number;
  durationMs?: number;
}

export function ThinkingSection({ texts, toolCount, durationMs }: ThinkingSectionProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);

  if (texts.length === 0) return null;

  const summary = buildSummary(texts.length, toolCount, durationMs);

  return (
    <div className="turn-thinking">
      <div className="turn-thinking__summary" onClick={() => setExpanded(!expanded)}>
        <span className={`turn-thinking__arrow ${expanded ? 'turn-thinking__arrow--expanded' : ''}`}>
          <ChevronRightIcon className="icon-arrow" />
        </span>
        <span className="turn-thinking__label">Thinking</span>
        <span className="turn-thinking__meta">{summary}</span>
      </div>
      {expanded && (
        <div className="turn-thinking__content">
          {texts.map((text, idx) => (
            <ReactMarkdown key={idx} remarkPlugins={[remarkGfm]}>
              {text}
            </ReactMarkdown>
          ))}
        </div>
      )}
    </div>
  );
}

function buildSummary(textCount: number, toolCount: number, durationMs?: number): string {
  const parts: string[] = [];
  if (textCount > 0) parts.push(`${textCount} thought${textCount > 1 ? 's' : ''}`);
  if (toolCount > 0) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`);
  if (durationMs !== undefined) parts.push(formatDuration(durationMs));
  return parts.join(' · ');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
