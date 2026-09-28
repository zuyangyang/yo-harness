import { describe, expect, it } from 'vitest';

import { EventBus } from '../../src/core/event-bus.js';
import type { AgentStatus } from '../../src/core/event-bus.js';
import type { EventEnvelope, TurnEndReason, Usage } from '../../src/types/events.js';

function envelope(seq: number): EventEnvelope {
  return {
    id: seq,
    sessionId: 's1',
    seq,
    ts: `2026-01-01T00:00:0${seq}.000Z`,
    payload: { type: 'user_input', content: `hello-${seq}` },
  };
}

function status(): AgentStatus {
  return {
    step: 1,
    maxSteps: 40,
    estTokens: 12,
    bodyBudgetTokens: 70_400,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

interface BusRecording {
  events: EventEnvelope[];
  deltas: string[];
  statuses: AgentStatus[];
  turns: { reason: TurnEndReason; usage: Usage }[];
}

/** 订阅全部通道并录制（与 CLI 渲染层的消费方式一致） */
function recordBus(bus: EventBus): BusRecording {
  const rec: BusRecording = { events: [], deltas: [], statuses: [], turns: [] };
  bus.on('event', (envelope) => rec.events.push(envelope));
  bus.on('llm_delta', (delta) => rec.deltas.push(delta));
  bus.on('status', (snapshot) => rec.statuses.push(snapshot));
  bus.on('turn_completed', (turn) => rec.turns.push(turn));
  return rec;
}

describe('EventBus', () => {
  it('四个通道各自往返，载荷原样送达', () => {
    const bus = new EventBus();
    const rec = recordBus(bus);

    const env = envelope(1);
    const turn = { reason: 'done' as const, usage: { inputTokens: 3, outputTokens: 4 } };

    expect(bus.emit('event', env)).toBe(true);
    expect(bus.emit('llm_delta', 'hello')).toBe(true);
    expect(bus.emit('status', status())).toBe(true);
    expect(bus.emit('turn_completed', turn)).toBe(true);

    expect(rec.events).toEqual([env]);
    expect(rec.deltas).toEqual(['hello']);
    expect(rec.statuses).toEqual([status()]);
    expect(rec.turns).toEqual([turn]);
  });

  it('同通道多订阅者都收到（多播）', () => {
    const bus = new EventBus();
    const first: string[] = [];
    const second: string[] = [];
    bus.on('llm_delta', (delta) => first.push(delta));
    bus.on('llm_delta', (delta) => second.push(delta));

    bus.emit('llm_delta', 'a');
    bus.emit('llm_delta', 'b');

    expect(first).toEqual(['a', 'b']);
    expect(second).toEqual(['a', 'b']);
  });

  it('off 取消订阅后不再送达，无订阅者时 emit 返回 false', () => {
    const bus = new EventBus();
    const got: string[] = [];
    const listener = (delta: string): void => {
      got.push(delta);
    };
    bus.on('llm_delta', listener);
    bus.off('llm_delta', listener);

    expect(bus.emit('llm_delta', 'x')).toBe(false);
    expect(got).toEqual([]);
  });
});
