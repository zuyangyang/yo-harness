/**
 * ApprovalDialog 单元测试：中文渲染 + 风险展示 + 裁决消息 + 遮罩不关闭。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalDialog } from '../../src/components/Approval/ApprovalDialog.js';
import * as wsModule from '../../src/api/websocket.js';

const mockRequest = {
  approvalId: 'a1',
  sessionId: 's1',
  toolName: 'shell',
  summary: 'rm -rf /tmp/test',
};

describe('ApprovalDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(wsModule.wsClient, 'resolveApproval').mockImplementation(() => {});
  });

  it('渲染中文标题、工具与摘要', () => {
    render(<ApprovalDialog request={mockRequest} />);
    expect(screen.getByText('需要你的确认')).toBeTruthy();
    expect(screen.getByText('shell')).toBeTruthy();
    expect(screen.getByText('rm -rf /tmp/test')).toBeTruthy();
  });

  it('展示风险等级与原因', () => {
    render(
      <ApprovalDialog
        request={{
          ...mockRequest,
          risk: { level: 'high', reasons: ['包含递归删除'], ruleIds: ['recursive-delete'] },
        }}
      />,
    );
    expect(screen.getByText(/包含递归删除/)).toBeTruthy();
    expect(screen.getByText(/^高/)).toBeTruthy();
  });

  it('点击「允许一次」发送 once', () => {
    const onResolve = vi.fn();
    render(<ApprovalDialog request={mockRequest} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', 'once');
    expect(onResolve).toHaveBeenCalled();
  });

  it('点击「本会话允许」发送 session', () => {
    render(<ApprovalDialog request={mockRequest} />);
    fireEvent.click(screen.getByRole('button', { name: '本会话允许' }));
    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', 'session');
  });

  it('点击「拒绝」发送 deny', () => {
    render(<ApprovalDialog request={mockRequest} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', 'deny');
  });

  it('点击遮罩不关闭、不发送裁决', () => {
    const { container } = render(<ApprovalDialog request={mockRequest} />);
    fireEvent.click(container.querySelector('.approval-overlay')!);
    expect(wsModule.wsClient.resolveApproval).not.toHaveBeenCalled();
  });
});
