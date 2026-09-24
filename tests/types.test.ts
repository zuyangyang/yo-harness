import { describe, expect, it } from 'vitest';
import { AgentEventSchema, ToolCallSchema } from '../src/types/events.js';

const sampleEvents = [
  { type: 'session_started', model: 'claude-sonnet-4-5', cwd: '/tmp/demo' },
  { type: 'user_input', content: '帮我看看这个项目' },
  {
    type: 'assistant_text',
    text: '我先看一下目录结构。',
    toolCalls: [
      { callId: 'call_1', toolName: 'list_dir', args: { path: '.' } },
    ],
  },
  { type: 'tool_call', callId: 'call_1', toolName: 'list_dir', args: { path: '.' } },
  {
    type: 'tool_result',
    callId: 'call_1',
    ok: true,
    content: 'src/\nREADME.md',
    durationMs: 12,
  },
  { type: 'approval_request', callId: 'call_2', toolName: 'write_file', summary: '写 src/a.ts (120B)' },
  { type: 'approval_result', callId: 'call_2', approved: true, scope: 'session' },
  { type: 'context_elided', count: 3, freedEstTokens: 8200 },
  { type: 'error', stage: 'llm', message: 'boom', recoverable: false },
  { type: 'turn_started', turnId: 'turn_1' },
  {
    type: 'turn_completed',
    turnId: 'turn_1',
    reason: 'done',
    usage: { inputTokens: 1200, outputTokens: 340 },
  },
] as const;

describe('事件 schema', () => {
  it('接受所有合法事件样例', () => {
    for (const event of sampleEvents) {
      expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
  });

  it('拒绝缺失必填字段的事件', () => {
    const result = AgentEventSchema.safeParse({
      type: 'tool_result',
      callId: 'call_1',
      ok: true,
      content: 'x',
      // 缺 durationMs
    });
    expect(result.success).toBe(false);
  });

  it('拒绝未知事件类型', () => {
    expect(AgentEventSchema.safeParse({ type: 'magic', foo: 1 }).success).toBe(false);
  });

  it('拒绝非法的 turn 结束原因', () => {
    const bad = {
      type: 'turn_completed',
      turnId: 't',
      reason: 'because_i_said_so',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    expect(AgentEventSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ToolCall schema', () => {
  it('接受字符串键的任意参数记录', () => {
    const call = { callId: 'c1', toolName: 'shell', args: { command: 'ls', nested: { a: 1 } } };
    expect(ToolCallSchema.safeParse(call).success).toBe(true);
  });

  it('拒绝空 callId / toolName', () => {
    expect(ToolCallSchema.safeParse({ callId: '', toolName: 'x', args: {} }).success).toBe(false);
    expect(ToolCallSchema.safeParse({ callId: 'c', toolName: '', args: {} }).success).toBe(false);
  });
});
