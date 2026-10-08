/**
 * 审批状态管理：按 approvalId 幂等 upsert / settle。
 *
 * 关键约定（修复「关掉弹窗就再也回不来」）：
 * - 只有在服务端确认已决（approval.resolved / approval.cancelled）时才移除；
 * - 刷新/重连补发与多标签页会重复到达，upsert 必须幂等。
 */
import { create } from 'zustand';

import type { ApprovalRequest } from '../api/websocket.js';

interface ApprovalState {
  /** 全局有序待审批（按到达顺序；同一 approvalId 只保留一份） */
  pendingApprovals: ApprovalRequest[];

  /** 新增或更新（WS 实时 / REST 补发，幂等） */
  upsert: (req: ApprovalRequest) => void;
  /** 服务端确认已决后移除 */
  settle: (approvalId: string) => void;
  /** 会话关闭/删除时清理 */
  clearSession: (sessionId: string) => void;
}

export const useApprovalStore = create<ApprovalState>()((set) => ({
  pendingApprovals: [],

  upsert: (req) => {
    set((state) => {
      const index = state.pendingApprovals.findIndex((a) => a.approvalId === req.approvalId);
      if (index === -1) {
        return { pendingApprovals: [...state.pendingApprovals, req] };
      }
      const next = state.pendingApprovals.slice();
      next[index] = req;
      return { pendingApprovals: next };
    });
  },

  settle: (approvalId) => {
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.approvalId !== approvalId),
    }));
  },

  clearSession: (sessionId) => {
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.sessionId !== sessionId),
    }));
  },
}));
