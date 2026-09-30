/**
 * ApprovalDialog 单元测试：渲染审批信息 + 点击按钮发送 WebSocket 消息。
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

  it('渲染工具名称和摘要', () => {
    render(<ApprovalDialog request={mockRequest} onDismiss={vi.fn()} />);

    expect(screen.getByText('shell')).toBeTruthy();
    expect(screen.getByText('rm -rf /tmp/test')).toBeTruthy();
  });

  it('渲染 Approve 和 Reject 按钮', () => {
    render(<ApprovalDialog request={mockRequest} onDismiss={vi.fn()} />);

    expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: 'Reject' }).length).toBeGreaterThanOrEqual(1);
  });

  it('点击 Approve 调用 wsClient.resolveApproval(true)', () => {
    const onDismiss = vi.fn();
    render(<ApprovalDialog request={mockRequest} onDismiss={onDismiss} />);

    const btn = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(btn);

    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', true, 'once');
    expect(onDismiss).toHaveBeenCalled();
  });

  it('点击 Reject 调用 wsClient.resolveApproval(false)', () => {
    const onDismiss = vi.fn();
    render(<ApprovalDialog request={mockRequest} onDismiss={onDismiss} />);

    const btn = screen.getByRole('button', { name: 'Reject' });
    fireEvent.click(btn);

    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', false, 'once');
    expect(onDismiss).toHaveBeenCalled();
  });

  it('选择 session scope 后发送正确参数', () => {
    const onDismiss = vi.fn();
    const { container } = render(<ApprovalDialog request={mockRequest} onDismiss={onDismiss} />);

    const radios = container.querySelectorAll<HTMLInputElement>('input[name="scope"]');
    const sessionRadio = Array.from(radios).find((r) => r.value === 'session')!;
    fireEvent.click(sessionRadio);

    const btn = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(btn);

    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', true, 'session');
  });

  it('点击 overlay 背景触发 onDismiss', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <ApprovalDialog request={mockRequest} onDismiss={onDismiss} />,
    );

    const overlay = container.querySelector('.approval-overlay')!;
    fireEvent.click(overlay);

    expect(onDismiss).toHaveBeenCalled();
  });
});
