/**
 * ApprovalCard：内联审批卡渲染与裁决消息。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalCard } from '../../src/components/Approval/ApprovalCard.js';
import * as wsModule from '../../src/api/websocket.js';
import type { ApprovalRequest } from '../../src/api/websocket.js';

const request: ApprovalRequest = {
  approvalId: 'a1',
  sessionId: 's1',
  toolName: 'shell',
  summary: 'rm -rf /tmp',
  risk: { level: 'high', reasons: ['包含递归删除'], ruleIds: ['recursive-delete'] },
};

describe('ApprovalCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(wsModule.wsClient, 'resolveApproval').mockImplementation(() => {});
  });

  it('展示摘要与风险原因', () => {
    render(<ApprovalCard request={request} />);
    expect(screen.getByText('需要你的确认')).toBeTruthy();
    expect(screen.getByText('rm -rf /tmp')).toBeTruthy();
    expect(screen.getByText(/包含递归删除/)).toBeTruthy();
  });

  it('允许一次 / 本会话允许 / 拒绝 发送对应 resolution', () => {
    render(<ApprovalCard request={request} />);
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', 'once');
  });

  it('本会话允许发送 session', () => {
    render(<ApprovalCard request={request} />);
    fireEvent.click(screen.getByRole('button', { name: '本会话允许' }));
    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', 'session');
  });

  it('拒绝发送 deny', () => {
    render(<ApprovalCard request={request} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(wsModule.wsClient.resolveApproval).toHaveBeenCalledWith('a1', 'deny');
  });
});
