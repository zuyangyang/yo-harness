/**
 * WebSocket 事件流 hook：订阅 wsClient 事件，转发到 session store。
 *
 * 设计约束：
 * - 全局单例：在 App 根组件调用一次，所有子组件通过 useSession 获取事件
 * - 自动清理：组件卸载时取消订阅
 */
import { useEffect } from 'react';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { wsClient, type ApprovalRequest } from '../api/websocket.js';
import { useSessionStore } from '../stores/session.js';
import { useApprovalStore } from '../stores/approval.js';

export function useWebSocket() {
  const addEvent = useSessionStore((state) => state.addEvent);
  const appendDelta = useSessionStore((state) => state.appendDelta);
  const addApproval = useApprovalStore((state) => state.addApproval);

  useEffect(() => {
    const onEvent = (sessionId: string, envelope: EventEnvelope): void => {
      addEvent(sessionId, envelope);
    };

    const onDelta = (sessionId: string, delta: string): void => {
      appendDelta(sessionId, delta);
    };

    const onApproval = (req: ApprovalRequest): void => {
      addApproval(req);
    };

    wsClient.on('event', onEvent);
    wsClient.on('delta', onDelta);
    wsClient.on('approval', onApproval);

    return () => {
      wsClient.off('event', onEvent);
      wsClient.off('delta', onDelta);
      wsClient.off('approval', onApproval);
    };
  }, [addEvent, appendDelta, addApproval]);
}
