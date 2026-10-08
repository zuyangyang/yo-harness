/**
 * 内联审批卡：出现在等待中的工具步骤内，就地允许/拒绝。
 *
 * 裁决走 WebSocket；出队由服务端 approval.resolved 事件驱动（多标签页一致）。
 */
import { useState } from 'react';

import type { ApprovalResolution } from '../../api/client.js';
import type { ApprovalRequest } from '../../api/websocket.js';
import { wsClient } from '../../api/websocket.js';

interface ApprovalCardProps {
  request: ApprovalRequest;
}

const RISK_LABEL: Record<string, string> = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
};

export function ApprovalCard({ request }: ApprovalCardProps): JSX.Element {
  const [resolving, setResolving] = useState<ApprovalResolution | null>(null);

  const resolve = (resolution: ApprovalResolution): void => {
    setResolving(resolution);
    wsClient.resolveApproval(request.approvalId, resolution);
  };

  return (
    <div className="approval-card" role="alertdialog" aria-label="需要你的确认">
      <div className="approval-card__title">需要你的确认</div>
      <div className="approval-card__summary">{request.summary}</div>
      {request.risk !== undefined && (
        <div className={`approval-card__risk approval-card__risk--${request.risk.level}`}>
          风险：{RISK_LABEL[request.risk.level] ?? request.risk.level}
          {request.risk.reasons.length > 0 ? ` · ${request.risk.reasons.join('；')}` : ''}
        </div>
      )}
      <div className="approval-card__actions">
        <button
          type="button"
          className="btn btn-success"
          disabled={resolving !== null}
          onClick={() => resolve('once')}
        >
          允许一次
        </button>
        <button
          type="button"
          className="btn"
          disabled={resolving !== null}
          onClick={() => resolve('session')}
        >
          本会话允许
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={resolving !== null}
          onClick={() => resolve('deny')}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
