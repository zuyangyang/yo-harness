/**
 * 审批路由 DTO 映射测试：前端统一读 approvalId（保留 id 兼容）。
 */
import { describe, it, expect } from 'vitest';
import { toPendingApprovalDto } from '../../src/routes/approvals.js';

describe('toPendingApprovalDto', () => {
  it('把 PendingApproval 映射为 approvalId 字段并保留 id', () => {
    const dto = toPendingApprovalDto({
      id: 'a1',
      sessionId: 's1',
      callId: 'c1',
      toolName: 'write_file',
      summary: 'write_file a.txt (2 chars)',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(dto).toEqual({
      approvalId: 'a1',
      id: 'a1',
      sessionId: 's1',
      callId: 'c1',
      toolName: 'write_file',
      summary: 'write_file a.txt (2 chars)',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
