/**
 * WebSocket 事件流 hook：订阅 wsClient 事件，转发到 session / approval store。
 *
 * 设计约束：
 * - 全局单例：在 App 根组件调用一次，所有子组件通过 store 获取事件
 * - 自动清理：组件卸载时取消订阅
 * - 审批恢复：连接（含重连）后按当前会话 REST 拉取未决审批，兜底补发丢失
 */
import { useEffect } from 'react';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { api } from '../api/client.js';
import { wsClient, type ApprovalRequest } from '../api/websocket.js';
import { useSessionStore } from '../stores/session.js';
import { useApprovalStore } from '../stores/approval.js';

export function useWebSocket() {
  const addEvent = useSessionStore((state) => state.addEvent);
  const appendDelta = useSessionStore((state) => state.appendDelta);
  const truncateEvents = useSessionStore((state) => state.truncateEvents);
  const upsertApproval = useApprovalStore((state) => state.upsert);
  const settleApproval = useApprovalStore((state) => state.settle);

  useEffect(() => {
    const onEvent = (sessionId: string, envelope: EventEnvelope): void => {
      addEvent(sessionId, envelope);
    };

    const onDelta = (sessionId: string, delta: string): void => {
      appendDelta(sessionId, delta);
    };

    const onTruncated = (sessionId: string, fromSeq: number): void => {
      truncateEvents(sessionId, fromSeq);
    };

    const onApproval = (req: ApprovalRequest): void => {
      upsertApproval(req);
    };

    const onResolved = (payload: { approvalId: string }): void => {
      settleApproval(payload.approvalId);
    };

    const onCancelled = (payload: { approvalId: string }): void => {
      settleApproval(payload.approvalId);
    };

    /** 连接/重连后用 REST 兜底恢复当前会话未决审批（WS 补发之外的保险） */
    const rehydrate = async (): Promise<void> => {
      const sessionId = useSessionStore.getState().currentSessionId;
      if (sessionId === null) return;
      try {
        const res = await api.sessions.getPendingApprovals(sessionId);
        for (const a of res.approvals) {
          upsertApproval({
            approvalId: a.approvalId,
            sessionId: a.sessionId,
            toolName: a.toolName,
            summary: a.summary,
            ...(a.callId !== undefined ? { callId: a.callId } : {}),
            ...(a.createdAt !== undefined ? { createdAt: a.createdAt } : {}),
          });
        }
      } catch {
        // 恢复失败不影响实时通道；用户仍可通过 WS 补发/后续事件恢复
      }
    };

    const onConnected = (): void => {
      void rehydrate();
    };

    wsClient.on('event', onEvent);
    wsClient.on('delta', onDelta);
    wsClient.on('truncated', onTruncated);
    wsClient.on('approval', onApproval);
    wsClient.on('approvalResolved', onResolved);
    wsClient.on('approvalCancelled', onCancelled);
    wsClient.on('connected', onConnected);

    return () => {
      wsClient.off('event', onEvent);
      wsClient.off('delta', onDelta);
      wsClient.off('truncated', onTruncated);
      wsClient.off('approval', onApproval);
      wsClient.off('approvalResolved', onResolved);
      wsClient.off('approvalCancelled', onCancelled);
      wsClient.off('connected', onConnected);
    };
  }, [addEvent, appendDelta, truncateEvents, upsertApproval, settleApproval]);
}
