/**
 * 审批状态管理：跟踪待审批请求，供 ApprovalDialog 消费。
 */
import { create } from 'zustand';

import type { ApprovalRequest } from '../api/websocket.js';

interface ApprovalState {
  pendingApprovals: ApprovalRequest[];
  addApproval: (req: ApprovalRequest) => void;
  removeApproval: (approvalId: string) => void;
  clearApprovals: () => void;
}

export const useApprovalStore = create<ApprovalState>()((set) => ({
  pendingApprovals: [],

  addApproval: (req) => {
    set((state) => ({
      pendingApprovals: [...state.pendingApprovals.filter((a) => a.approvalId !== req.approvalId), req],
    }));
  },

  removeApproval: (approvalId) => {
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.approvalId !== approvalId),
    }));
  },

  clearApprovals: () => set({ pendingApprovals: [] }),
}));
