/**
 * 工具调用卡片：展示工具名称、参数、执行状态。
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
    <div
      style={{
        marginBottom: 15,
        padding: 12,
        background: '#f5f5f5',
        border: '1px solid #ddd',
        borderRadius: 8,
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 5, color: '#333' }}>
        🔧 {toolName}
      </div>
      {argsPreview && (
        <div style={{ color: '#666', fontFamily: 'monospace', fontSize: 12 }}>
          {argsPreview}
        </div>
      )}
    </div>
  );
}
