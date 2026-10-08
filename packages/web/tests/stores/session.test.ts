/**
 * 会话 store 流式增量测试：累积、提交清空、多会话隔离。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { useSessionStore } from '../../src/stores/session.js';

let seq = 0;
function env(payload: EventEnvelope['payload'], sessionId = 's1'): EventEnvelope {
  seq += 1;
  return { id: seq, sessionId, seq, ts: '2025-06-15T10:00:00.000Z', payload };
}

beforeEach(() => {
  seq = 0;
  useSessionStore.setState({ events: new Map(), deltas: new Map() });
});

describe('session store 流式增量', () => {
  it('appendDelta 累积同一会话的增量', () => {
    const store = useSessionStore.getState();
    store.appendDelta('s1', '你');
    store.appendDelta('s1', '好');

    expect(useSessionStore.getState().deltas.get('s1')).toBe('你好');
  });

  it('空增量不产生状态变更', () => {
    useSessionStore.getState().appendDelta('s1', '');
    expect(useSessionStore.getState().deltas.has('s1')).toBe(false);
  });

  it('assistant_text 提交后清空该会话的流式缓冲', () => {
    useSessionStore.getState().appendDelta('s1', '半截');
    useSessionStore.getState().addEvent('s1', env({ type: 'assistant_text', text: '完整', toolCalls: [] }));

    expect(useSessionStore.getState().deltas.has('s1')).toBe(false);
    expect(useSessionStore.getState().events.get('s1')).toHaveLength(1);
  });

  it('turn_completed 兜底清空流式缓冲', () => {
    useSessionStore.getState().appendDelta('s1', '半截');
    useSessionStore.getState().addEvent(
      's1',
      env({ type: 'turn_completed', turnId: 't1', reason: 'interrupted', usage: { inputTokens: 0, outputTokens: 0 } }),
    );

    expect(useSessionStore.getState().deltas.has('s1')).toBe(false);
  });

  it('多会话增量互不影响', () => {
    const store = useSessionStore.getState();
    store.appendDelta('s1', 'a');
    store.appendDelta('s2', 'b');
    store.addEvent('s1', env({ type: 'assistant_text', text: 'done', toolCalls: [] }));

    const deltas = useSessionStore.getState().deltas;
    expect(deltas.has('s1')).toBe(false);
    expect(deltas.get('s2')).toBe('b');
  });
});
