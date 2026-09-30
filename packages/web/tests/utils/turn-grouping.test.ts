import { describe, expect, it } from 'vitest';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { groupEventsIntoTurns } from '../../src/utils/turn-grouping.js';

let seq = 0;
function env(payload: EventEnvelope['payload']): EventEnvelope {
  seq += 1;
  return { id: seq, sessionId: 's1', seq, ts: '2025-06-15T10:00:00.000Z', payload };
}

describe('groupEventsIntoTurns meta extraction', () => {
  it('collects context_compressed into a meta chip', () => {
    const events = [
      env({ type: 'user_input', content: 'hi' }),
      env({
        type: 'context_compressed',
        compressedCount: 3,
        beforeTokens: 1000,
        afterTokens: 500,
        strategy: 'tool_results',
      }),
      env({
        type: 'turn_completed',
        turnId: 't1',
        reason: 'done',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    ];

    const turns = groupEventsIntoTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.meta).toHaveLength(1);
    expect(turns[0]?.meta[0]?.kind).toBe('context');
    expect(turns[0]?.meta[0]?.detail).toBe('1000→500 tokens');
  });

  it('collects checkpoint and memory events', () => {
    const events = [
      env({ type: 'user_input', content: 'write code' }),
      env({ type: 'checkpoint_created', checkpointId: 'c1', files: ['a.ts', 'b.ts'], source: 'auto_write' }),
      env({ type: 'memory_extracted', count: 2, source: 'manual' }),
    ];

    const turns = groupEventsIntoTurns(events);
    const kinds = turns[0]?.meta.map((m) => m.kind);
    expect(kinds).toEqual(['checkpoint', 'memory']);
  });

  it('uses the last tool-free assistant_text as the final reply', () => {
    const events = [
      env({ type: 'user_input', content: 'hi' }),
      env({
        type: 'assistant_text',
        text: 'thinking…',
        toolCalls: [{ callId: 'c1', toolName: 'bash', args: {} }],
      }),
      env({ type: 'assistant_text', text: 'final answer', toolCalls: [] }),
    ];

    const turns = groupEventsIntoTurns(events);
    expect(turns[0]?.finalText).toBe('final answer');
    expect(turns[0]?.thinkingTexts).toEqual(['thinking…']);
  });
});
