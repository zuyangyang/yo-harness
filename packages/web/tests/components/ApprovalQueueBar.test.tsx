/**
 * ApprovalQueueBar：待办条数量/摘要与「处理」入口。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalQueueBar } from '../../src/components/Approval/ApprovalQueueBar.js';
import type { ApprovalRequest } from '../../src/api/websocket.js';

const req: ApprovalRequest = {
  approvalId: 'a1',
  sessionId: 's1',
  toolName: 'write_file',
  summary: 'write_file a.txt (2 chars)',
};

describe('ApprovalQueueBar', () => {
  it('无待审批时不渲染', () => {
    const { container } = render(<ApprovalQueueBar approvals={[]} onOpen={vi.fn()} />);
    expect(container.querySelector('.approval-bar')).toBeNull();
  });

  it('显示数量与摘要，点击「处理」触发回调', () => {
    const onOpen = vi.fn();
    render(<ApprovalQueueBar approvals={[req]} onOpen={onOpen} />);
    expect(screen.getByText(/有 1 个操作等待你的确认/)).toBeTruthy();
    expect(screen.getByText('write_file a.txt (2 chars)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '处理' }));
    expect(onOpen).toHaveBeenCalled();
  });
});
