/**
 * 审批弹窗：展示工具调用摘要与风险原因，通过 WebSocket 发送裁决。
 *
 * 设计约束：
 * - 点击遮罩不关闭：必须明确选择允许/拒绝，避免把挂起的 turn 永久丢弃；
 * - 裁决后不做本地出队，等服务端 approval.resolved 事件（多标签页一致）。
 */
import { useCallback, useState } from 'react';

import type { ApprovalResolution } from '../../api/client.js';
import type { ApprovalRequest } from '../../api/websocket.js';
import { wsClient } from '../../api/websocket.js';

interface ApprovalDialogProps {
  request: ApprovalRequest;
  /** 提交成功后的回调（例如关闭聚焦态）；不代表审批已解决 */
  onResolve?: () => void;
}

const RISK_LABEL: Record<string, string> = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
};

export function ApprovalDialog({ request, onResolve }: ApprovalDialogProps): JSX.Element {
  const [resolving, setResolving] = useState<ApprovalResolution | null>(null);

  const handleResolve = useCallback(
    (resolution: ApprovalResolution) => {
      setResolving(resolution);
      wsClient.resolveApproval(request.approvalId, resolution);
      onResolve?.();
    },
    [request.approvalId, onResolve],
  );

  return (
    <div className="approval-overlay">
      <div className="approval-dialog" role="alertdialog" aria-modal="true" aria-label="需要你的确认">
        <h3>需要你的确认</h3>

        <div className="approval-info">
          <p>
            <strong>工具：</strong> <code>{request.toolName}</code>
          </p>
          <p>
            <strong>详情：</strong> {request.summary}
          </p>
          {request.risk !== undefined && (
            <p className={`approval-risk approval-risk--${request.risk.level}`}>
              <strong>风险：</strong>
              {RISK_LABEL[request.risk.level] ?? request.risk.level}
              {request.risk.reasons.length > 0 ? ` · ${request.risk.reasons.join('；')}` : ''}
            </p>
          )}
        </div>

        <div className="approval-actions">
          <button
            className="btn btn-success"
            disabled={resolving !== null}
            onClick={() => handleResolve('once')}
          >
            允许一次
          </button>
          <button
            className="btn"
            disabled={resolving !== null}
            onClick={() => handleResolve('session')}
          >
            本会话允许
          </button>
          <button
            className="btn btn-danger"
            disabled={resolving !== null}
            onClick={() => handleResolve('deny')}
          >
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
}
