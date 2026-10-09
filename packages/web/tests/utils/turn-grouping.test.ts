import { describe, expect, it } from 'vitest';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { groupEventsIntoTurns } from '../../src/utils/turn-grouping.js';

let seq = 0;
function env(payload: EventEnvelope['payload']): EventEnvelope {
  seq += 1;
  return { id: seq, sessionId: 's1', seq, ts: '2025-06-15T10:00:00.000Z', payload };
}

describe('groupEventsIntoTurns 回退锚点', () => {
  it('每个 turn 记录其 user_input 事件的 seq', () => {
    const events = [
      env({ type: 'session_started', model: 'm', cwd: '/tmp' }),
      env({ type: 'user_input', content: 'first' }),
      env({ type: 'assistant_text', text: 'ok', toolCalls: [] }),
      env({ type: 'user_input', content: 'second' }),
    ];

    const turns = groupEventsIntoTurns(events);

    expect(turns.map((t) => t.userInputSeq)).toEqual([events[1]!.seq, events[3]!.seq]);
    expect(turns.map((t) => t.userMessage)).toEqual(['first', 'second']);
  });
});

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

  it('session_started 决定其后各 turn 的生效模型', () => {
    const events = [
      env({ type: 'session_started', model: 'deepseek-v4-pro', cwd: '/tmp' }),
      env({ type: 'user_input', content: 'hi' }),
      env({
        type: 'turn_completed',
        turnId: 't1',
        reason: 'done',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      env({ type: 'session_started', model: 'claude-sonnet-4-5', cwd: '/tmp' }),
      env({ type: 'user_input', content: 'again' }),
    ];

    const turns = groupEventsIntoTurns(events);
    expect(turns.map((t) => t.model)).toEqual(['deepseek-v4-pro', 'claude-sonnet-4-5']);
  });

  it('没有 session_started 时 model 缺省', () => {
    const turns = groupEventsIntoTurns([env({ type: 'user_input', content: 'hi' })]);
    expect(turns[0]?.model).toBeUndefined();
  });

  it('approval_result 清除 waitingApproval，工具完成后不再残留 waiting 状态', () => {
    const events = [
      env({ type: 'user_input', content: '把它记下来' }),
      env({
        type: 'assistant_text',
        text: '',
        toolCalls: [{ callId: 'c1', toolName: 'write_file', args: {} }],
      }),
      env({
        type: 'tool_call',
        callId: 'c1',
        toolName: 'write_file',
        args: { path: 'NOTES.md' },
      }),
      env({
        type: 'approval_request',
        callId: 'c1',
        toolName: 'write_file',
        summary: 'write_file NOTES.md (24 chars)',
      }),
      env({ type: 'approval_result', callId: 'c1', approved: true, scope: 'once' }),
      env({
        type: 'tool_result',
        callId: 'c1',
        ok: true,
        content: 'wrote 40 bytes to NOTES.md',
        durationMs: 2,
      }),
    ];

    const step = groupEventsIntoTurns(events)[0]?.toolSteps[0];
    expect(step?.waitingApproval).toBeUndefined();
    expect(step?.approvalResult).toEqual({ approved: true });
    expect(step?.result?.ok).toBe(true);
  });

  it('仅 approval_request 到达时保持 waitingApproval', () => {
    const events = [
      env({ type: 'user_input', content: 'write' }),
      env({ type: 'tool_call', callId: 'c1', toolName: 'write_file', args: { path: 'a.md' } }),
      env({
        type: 'approval_request',
        callId: 'c1',
        toolName: 'write_file',
        summary: 'write_file a.md (2 chars)',
      }),
    ];

    const step = groupEventsIntoTurns(events)[0]?.toolSteps[0];
    expect(step?.waitingApproval).toEqual({ summary: 'write_file a.md (2 chars)' });
    expect(step?.approvalResult).toBeUndefined();
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

  it('turn_completed 的 cost 提取到 turn', () => {
    const events = [
      env({ type: 'user_input', content: 'hi' }),
      env({
        type: 'turn_completed',
        turnId: 't1',
        reason: 'done',
        usage: { inputTokens: 10, outputTokens: 20 },
        cost: 0.02,
      }),
    ];

    const turns = groupEventsIntoTurns(events);
    expect(turns[0]?.cost).toBe(0.02);
  });

  it('无 cost 的 turn_completed 不产生 cost 字段', () => {
    const events = [
      env({ type: 'user_input', content: 'hi' }),
      env({
        type: 'turn_completed',
        turnId: 't1',
        reason: 'done',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    ];

    const turns = groupEventsIntoTurns(events);
    expect(turns[0]?.cost).toBeUndefined();
  });
});
