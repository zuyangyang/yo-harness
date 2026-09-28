/**
 * 审批弹窗：展示工具调用摘要 + args 预览，Approve/Reject 按钮通过 WebSocket 发送 resolve。
 */
import { useCallback, useState } from 'react';

import type { ApprovalRequest } from '../../api/websocket.js';
import { wsClient } from '../../api/websocket.js';

interface ApprovalDialogProps {
  request: ApprovalRequest;
  onDismiss: () => void;
}

export function ApprovalDialog({ request, onDismiss }: ApprovalDialogProps): JSX.Element {
  const [scope, setScope] = useState<'once' | 'session'>('once');
  const [resolving, setResolving] = useState(false);

  const handleResolve = useCallback(
    (approved: boolean) => {
      setResolving(true);
      wsClient.resolveApproval(request.approvalId, approved, scope);
      onDismiss();
    },
    [request.approvalId, scope, onDismiss],
  );

  return (
    <div className="approval-overlay" onClick={onDismiss}>
      <div className="approval-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Tool Approval Required</h3>

        <div className="approval-info">
          <p>
            <strong>Tool:</strong> <code>{request.toolName}</code>
          </p>
          <p>
            <strong>Summary:</strong> {request.summary}
          </p>
        </div>

        <div className="approval-scope">
          <label>
            <input
              type="radio"
              name="scope"
              value="once"
              checked={scope === 'once'}
              onChange={() => setScope('once')}
            />
            Approve once
          </label>
          <label>
            <input
              type="radio"
              name="scope"
              value="session"
              checked={scope === 'session'}
              onChange={() => setScope('session')}
            />
            Approve for this session
          </label>
        </div>

        <div className="approval-actions">
          <button
            className="btn-approve"
            disabled={resolving}
            onClick={() => handleResolve(true)}
          >
            Approve
          </button>
          <button
            className="btn-reject"
            disabled={resolving}
            onClick={() => handleResolve(false)}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
