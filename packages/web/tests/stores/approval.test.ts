/**
 * approval store：upsert 幂等 / settle / clearSession。
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { useApprovalStore } from '../../src/stores/approval.js';

function req(approvalId: string, sessionId = 's1') {
  return { approvalId, sessionId, toolName: 'shell', summary: approvalId };
}

describe('approval store', () => {
  beforeEach(() => {
    useApprovalStore.setState({ pendingApprovals: [] });
  });

  it('upsert 幂等：同一 approvalId 只保留一份并更新内容', () => {
    const { upsert } = useApprovalStore.getState();
    upsert(req('a1'));
    upsert({ ...req('a1'), summary: 'updated' });
    const list = useApprovalStore.getState().pendingApprovals;
    expect(list).toHaveLength(1);
    expect(list[0]?.summary).toBe('updated');
  });

  it('settle 按 approvalId 移除', () => {
    const s = useApprovalStore.getState();
    s.upsert(req('a1'));
    s.upsert(req('a2'));
    s.settle('a1');
    expect(useApprovalStore.getState().pendingApprovals.map((a) => a.approvalId)).toEqual(['a2']);
  });

  it('clearSession 只清理该会话', () => {
    const s = useApprovalStore.getState();
    s.upsert(req('a1', 's1'));
    s.upsert(req('a2', 's2'));
    s.clearSession('s1');
    expect(useApprovalStore.getState().pendingApprovals.map((a) => a.approvalId)).toEqual(['a2']);
  });
});
