/**
 * 消息气泡：根据事件类型渲染不同内容。
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
        <div style={{ marginBottom: 15, display: 'flex', justifyContent: 'flex-end' }}>
          <div
            style={{
              maxWidth: '70%',
              padding: 12,
              background: '#007bff',
              color: '#fff',
              borderRadius: 12,
              borderBottomRightRadius: 4,
            }}
          >
            {payload.content}
          </div>
        </div>
      );

    case 'assistant_text':
      return (
        <div style={{ marginBottom: 15, display: 'flex' }}>
          <div
            style={{
              maxWidth: '70%',
              padding: 12,
              background: '#fff',
              border: '1px solid #e0e0e0',
              borderRadius: 12,
              borderBottomLeftRadius: 4,
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{payload.text}</ReactMarkdown>
          </div>
        </div>
      );

    case 'tool_call':
      return <ToolCallCard key={payload.callId} callId={payload.callId} toolName={payload.toolName} args={payload.args} />;

    case 'tool_result':
      return null; // Tool results are shown inline in ToolCallCard

    case 'error':
      return (
        <div style={{ marginBottom: 15, padding: 12, background: '#fee', border: '1px solid #fcc', borderRadius: 4, color: '#c00' }}>
          <strong>Error ({payload.stage}):</strong> {payload.message}
        </div>
      );

    default:
      return null;
  }
}
