import { describe, expect, it } from 'vitest';
import { AgentEventSchema, ToolCallSchema } from '../src/types/events.js';
import { PlanOutputSchema } from '../src/types/plan.js';

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
  // ─── Phase 2 新增事件 ───
  {
    type: 'context_compressed',
    compressedCount: 5,
    beforeTokens: 40000,
    afterTokens: 12000,
    strategy: 'tool_results',
  },
  {
    type: 'checkpoint_created',
    checkpointId: 'cp_1',
    files: ['src/a.ts'],
    source: 'auto_write',
  },
  {
    type: 'checkpoint_restored',
    checkpointId: 'cp_1',
    direction: 'undo',
    files: ['src/a.ts'],
  },
  {
    type: 'plan_created',
    plan: {
      id: 'plan_1',
      objective: '重构 auth 模块',
      tasks: [{ id: '1', title: '分析现有代码', status: 'pending', acceptance: ['列出依赖'], children: [] }],
      verificationCriteria: ['npm test 全绿'],
      createdAt: '2026-09-28T00:00:00Z',
    },
  },
  { type: 'plan_approved', planId: 'plan_1' },
  { type: 'plan_rejected', planId: 'plan_1', reason: '任务拆分太粗' },
  { type: 'plan_task_updated', planId: 'plan_1', taskId: '1', status: 'completed' },
  { type: 'goal_reminder', goal: '重构 auth 模块', stepsSinceProgress: 10 },
  // ─── Phase 3 新增事件 ───
  { type: 'memory_extracted', count: 3, source: 'session_end' },
  { type: 'memory_injected', count: 2, memoryIds: ['mem_1', 'mem_2'] },
  { type: 'task_started', taskId: 'bg-1', description: '跑测试', sessionId: 'sess-1' },
  { type: 'task_completed', taskId: 'bg-1', reason: 'done', summary: '全部通过' },
  { type: 'task_failed', taskId: 'bg-2', error: 'OOM' },
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

describe('PlanOutput schema（Phase 2）', () => {
  it('接受合法的规划输出', () => {
    const plan = {
      objective: '重构 auth 模块',
      tasks: [
        {
          id: '1',
          title: '分析现有代码',
          acceptance: ['列出所有依赖'],
          children: [
            { id: '1.1', title: '读取 auth.ts', acceptance: ['识别导出函数'] },
          ],
        },
        { id: '2', title: '设计新接口', acceptance: ['接口文档'], children: [] },
      ],
      verificationCriteria: ['npm test 全绿', '无 lint 错误'],
    };
    expect(PlanOutputSchema.safeParse(plan).success).toBe(true);
  });

  it('拒绝空 objective', () => {
    const plan = { objective: '', tasks: [], verificationCriteria: [] };
    expect(PlanOutputSchema.safeParse(plan).success).toBe(false);
  });

  it('拒绝空 task id', () => {
    const plan = {
      objective: 'test',
      tasks: [{ id: '', title: 'x', acceptance: [], children: [] }],
      verificationCriteria: [],
    };
    expect(PlanOutputSchema.safeParse(plan).success).toBe(false);
  });
});
