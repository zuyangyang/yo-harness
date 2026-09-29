/**
 * Message bubble: renders different content based on event type.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { ToolCallCard } from './ToolCallCard.js';

interface MessageBubbleProps {
  envelope: EventEnvelope;
}

export function MessageBubble({ envelope }: MessageBubbleProps): JSX.Element | null {
  const { payload } = envelope;

  switch (payload.type) {
    case 'user_input':
      return (
        <div className="message-row message-row--user">
          <div className="message-bubble message-bubble--user">
            {payload.content}
          </div>
        </div>
      );

    case 'assistant_text':
      return (
        <div className="message-row message-row--assistant">
          <div className="message-bubble message-bubble--assistant">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{payload.text}</ReactMarkdown>
          </div>
        </div>
      );

    case 'tool_call':
      return <ToolCallCard key={payload.callId} callId={payload.callId} toolName={payload.toolName} args={payload.args} />;

    case 'tool_result':
      return null;

    case 'error':
      return (
        <div className="message-row">
          <div className="message-bubble message-bubble--error">
            <strong>Error ({payload.stage}):</strong> {payload.message}
          </div>
        </div>
      );

    default:
      return null;
  }
}
