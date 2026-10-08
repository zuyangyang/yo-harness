/**
 * 待审批待办条：常驻输入框上方，保证工具卡被折叠/滚出视口时仍有入口。
 */
import type { ApprovalRequest } from '../../api/websocket.js';
import { ExclamationTriangleIcon } from '../Icons/index.js';

interface ApprovalQueueBarProps {
  approvals: ApprovalRequest[];
  onOpen: () => void;
}

export function ApprovalQueueBar({ approvals, onOpen }: ApprovalQueueBarProps): JSX.Element | null {
  if (approvals.length === 0) return null;
  const first = approvals[0]!;

  return (
    <div className="approval-bar" role="status" aria-live="polite">
      <ExclamationTriangleIcon className="icon-svg approval-bar__icon" />
      <span className="approval-bar__text">
        有 {approvals.length} 个操作等待你的确认
        <span className="approval-bar__summary">{first.summary}</span>
      </span>
      <button type="button" className="btn btn-warning approval-bar__action" onClick={onOpen}>
        处理
      </button>
    </div>
  );
}
