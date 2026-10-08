/**
 * ToolSteps：等待审批时按 callId 关联待审批项并渲染内联审批卡。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToolSteps } from '../../src/components/Chat/ToolSteps.js';
import { useApprovalStore } from '../../src/stores/approval.js';
import type { ToolStep } from '../../src/utils/turn-grouping.js';

const step: ToolStep = {
  callId: 'c1',
  toolName: 'write_file',
  args: { path: 'a.txt' },
  waitingApproval: { summary: 'write_file a.txt (2 chars)' },
};

describe('ToolSteps 内联审批', () => {
  beforeEach(() => {
    useApprovalStore.setState({ pendingApprovals: [] });
  });

  it('有匹配的待审批 → 渲染审批卡', () => {
    useApprovalStore.getState().upsert({
      approvalId: 'a1',
      sessionId: 's1',
      callId: 'c1',
      toolName: 'write_file',
      summary: 'write_file a.txt (2 chars)',
    });
    render(<ToolSteps steps={[step]} />);
    fireEvent.click(screen.getByText(/1 tool call/));
    expect(screen.getByText('需要你的确认')).toBeTruthy();
    expect(screen.getByRole('button', { name: '允许一次' })).toBeTruthy();
  });

  it('无匹配待审批 → 退回只读 waiting 文案', () => {
    render(<ToolSteps steps={[step]} />);
    fireEvent.click(screen.getByText(/1 tool call/));
    expect(screen.getByText(/Waiting approval/)).toBeTruthy();
  });

  it('审批已决且执行完成 → 不再显示 waiting 统计与文案', () => {
    const doneStep: ToolStep = {
      callId: 'c2',
      toolName: 'write_file',
      args: { path: 'NOTES.md' },
      approvalResult: { approved: true },
      result: { ok: true, content: 'wrote 40 bytes to NOTES.md', durationMs: 2 },
    };
    render(<ToolSteps steps={[doneStep]} />);
    expect(screen.getByText(/1 ok/)).toBeTruthy();
    expect(screen.queryByText(/waiting/)).toBeNull();
  });
});
