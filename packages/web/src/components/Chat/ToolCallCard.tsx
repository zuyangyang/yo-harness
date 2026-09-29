/**
 * Tool call card: displays tool name, args, and execution status.
 */

interface ToolCallCardProps {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export function ToolCallCard({ toolName, args }: ToolCallCardProps): JSX.Element {
  const argsPreview = Object.entries(args)
    .map(([key, value]) => {
      const val = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}: ${val.length > 50 ? `${val.slice(0, 50)}...` : val}`;
    })
    .join(', ');

  return (
    <div className="message-row message-row--assistant">
      <div className="message-bubble message-bubble--assistant">
        <div className="tool-call-card">
          <div className="tool-call-header">
            <span className="tool-call-icon"></span>
            <span>{toolName}</span>
          </div>
          {argsPreview && (
            <div className="tool-call-args">
              {argsPreview}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
