/**
 * 状态栏：连接状态 / context 占用 / step 计数 / token 用量。
 *
 * 数据从 WebSocket 连接状态 + 当前会话事件流中提取。
 */
import { useEffect, useState } from 'react';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { wsClient } from '../../api/websocket.js';
import { useSessionStore } from '../../stores/session.js';

function extractStats(events: EventEnvelope[]): { steps: number; tokens: number } {
  let steps = 0;
  let tokens = 0;
  for (const env of events) {
    if (env.payload.type === 'turn_started') steps++;
    if (env.payload.type === 'turn_completed') {
      const p = env.payload as Record<string, unknown>;
      const usage = p.usage as { totalTokens?: number } | undefined;
      if (usage?.totalTokens) tokens += usage.totalTokens;
    }
  }
  return { steps, tokens };
}

export function StatusBar(): JSX.Element {
  const [connected, setConnected] = useState(false);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const eventsMap = useSessionStore((s) => s.events);
  const events = currentSessionId ? eventsMap.get(currentSessionId) ?? [] : [];

  useEffect(() => {
    const onConnected = () => setConnected(true);
    const onDisconnected = () => setConnected(false);

    wsClient.on('connected', onConnected);
    wsClient.on('disconnected', onDisconnected);

    // Check initial state — assume disconnected until 'connected' event fires
    setConnected(false);

    return () => {
      wsClient.off('connected', onConnected);
      wsClient.off('disconnected', onDisconnected);
    };
  }, []);

  const { steps, tokens } = extractStats(events);

  return (
    <div className="status-bar">
      <span className={`status-indicator ${connected ? 'status-connected' : 'status-disconnected'}`}>
        {connected ? 'Connected' : 'Disconnected'}
      </span>
      <span className="status-item">Steps: {steps}</span>
      <span className="status-item">Tokens: {tokens.toLocaleString()}</span>
      <span className="status-item">Events: {events.length}</span>
    </div>
  );
}
