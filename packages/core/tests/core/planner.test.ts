import { describe, expect, it } from 'vitest';

import { Planner, readOnlyResolver } from '../../src/core/planner.js';
import type { Logger } from '../../src/types/common.js';
import type { ToolCall } from '../../src/types/events.js';
import type { ChatResponse, LLMClient } from '../../src/types/llm.js';
import type { Tool, ToolResult, ToolSpec } from '../../src/types/tools.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { PermissionManager } from '../../src/core/permission.js';
import type { ToolResolver } from '../../src/core/ports.js';

// ---------------------------------------------------------------------------
// 测试设施
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  debug: () => { /* noop */ },
  info: () => { /* noop */ },
  warn: () => { /* noop */ },
  error: () => { /* noop */ },
};

/** 模拟 LLM 客户端：按顺序返回预设响应 */
class FakeLLM implements LLMClient {
  readonly name = 'fake';
  private responses: ChatResponse[] = [];
  private callCount = 0;

  constructor(responses: ChatResponse[]) {
    this.responses = responses;
  }

  chat(): Promise<ChatResponse> {
    const resp = this.responses[this.callCount] ?? this.responses[this.responses.length - 1];
    this.callCount++;
    if (resp === undefined) {
      throw new Error('No more responses');
    }
    return Promise.resolve(resp);
  }

  get calls(): number {
    return this.callCount;
  }
}

/** 模拟工具 */
class FakeTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly risk: 'read' | 'write';
  readonly inputSchema = {} as Tool['inputSchema'];
  private result: ToolResult;

  constructor(name: string, risk: 'read' | 'write', result: ToolResult) {
    this.name = name;
    this.description = `Fake ${name} tool`;
    this.risk = risk;
    this.result = result;
  }

  run(): Promise<ToolResult> {
    return Promise.resolve(this.result);
  }
}

/** 模拟工具解析器 */
class FakeToolResolver implements ToolResolver {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {},
    }));
  }
}

/** 模拟权限管理器：始终批准 */
const alwaysApprove: PermissionManager = {
  request: () => Promise.resolve({ approved: true as const, scope: 'once' as const }),
};

/** 创建有效计划 JSON */
function makePlanJson(): string {
  return JSON.stringify({
    objective: 'Test objective',
    tasks: [
      {
        id: '1',
        title: 'First task',
        acceptance: ['criterion 1'],
        children: [],
      },
    ],
    verificationCriteria: ['verification 1'],
  });
}

// ---------------------------------------------------------------------------
// Planner 测试
// ---------------------------------------------------------------------------

describe('Planner', () => {
  it('直接输出计划 JSON（无工具调用）', async () => {
    const planJson = makePlanJson();
    const llm = new FakeLLM([
      { text: planJson, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 50 } },
    ]);
    const resolver = new FakeToolResolver();
    const bus = new EventBus();

    const planner = new Planner({
      llm,
      tools: resolver,
      permission: alwaysApprove,
      sessionId: 'test-session',
      cwd: '/test',
      logger: noopLogger,
      bus,
      maxExploreSteps: 5,
    });

    const result = await planner.plan('Do something');
    expect(result).not.toBeNull();
    expect(result?.plan.objective).toBe('Test objective');
    expect(result?.plan.tasks).toHaveLength(1);
    expect(result?.plan.tasks[0]?.title).toBe('First task');
    expect(result?.plan.tasks[0]?.status).toBe('pending');
    expect(llm.calls).toBe(1);
  });

  it('工具调用后输出计划', async () => {
    const planJson = makePlanJson();
    const tool = new FakeTool('read_file', 'read', { ok: true, content: 'file content' });
    const resolver = new FakeToolResolver();
    resolver.register(tool);

    const toolCall: ToolCall = { callId: 'c1', toolName: 'read_file', args: { path: 'test.txt' } };
    const llm = new FakeLLM([
      // 第一次调用：请求工具
      { text: 'Let me read the file', toolCalls: [toolCall], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 20 } },
      // 第二次调用：输出计划
      { text: planJson, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 50 } },
    ]);
    const bus = new EventBus();

    const planner = new Planner({
      llm,
      tools: resolver,
      permission: alwaysApprove,
      sessionId: 'test-session',
      cwd: '/test',
      logger: noopLogger,
      bus,
      maxExploreSteps: 5,
    });

    const result = await planner.plan('Do something');
    expect(result).not.toBeNull();
    expect(result?.plan.objective).toBe('Test objective');
    expect(llm.calls).toBe(2);
    // 检查探索消息历史包含工具调用和结果
    expect(result?.explorationMessages).toHaveLength(4); // user, assistant+tool_call, tool_result, assistant
  });

  it('达到最大步数未产出计划 → 返回 null', async () => {
    const llm = new FakeLLM([
      // 始终请求工具，不输出计划
      { text: 'exploring...', toolCalls: [{ callId: 'c1', toolName: 'read_file', args: {} }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 10 } },
    ]);
    const tool = new FakeTool('read_file', 'read', { ok: true, content: 'content' });
    const resolver = new FakeToolResolver();
    resolver.register(tool);
    const bus = new EventBus();

    const planner = new Planner({
      llm,
      tools: resolver,
      permission: alwaysApprove,
      sessionId: 'test-session',
      cwd: '/test',
      logger: noopLogger,
      bus,
      maxExploreSteps: 3,
    });

    const result = await planner.plan('Do something');
    expect(result).toBeNull();
    expect(llm.calls).toBe(3);
  });

  it('解析失败后重试成功', async () => {
    const planJson = makePlanJson();
    const llm = new FakeLLM([
      // 第一次：无效 JSON
      { text: 'not valid json', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } },
      // 第二次：有效计划
      { text: planJson, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 50 } },
    ]);
    const resolver = new FakeToolResolver();
    const bus = new EventBus();

    const planner = new Planner({
      llm,
      tools: resolver,
      permission: alwaysApprove,
      sessionId: 'test-session',
      cwd: '/test',
      logger: noopLogger,
      bus,
      maxExploreSteps: 5,
    });

    const result = await planner.plan('Do something');
    expect(result).not.toBeNull();
    expect(result?.plan.objective).toBe('Test objective');
    expect(llm.calls).toBe(2);
  });

  it('解析 markdown 代码块中的 JSON', async () => {
    const planJson = makePlanJson();
    const markdownOutput = `Here is the plan:\n\n\`\`\`json\n${planJson}\n\`\`\`\n\nDone.`;
    const llm = new FakeLLM([
      { text: markdownOutput, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 50 } },
    ]);
    const resolver = new FakeToolResolver();
    const bus = new EventBus();

    const planner = new Planner({
      llm,
      tools: resolver,
      permission: alwaysApprove,
      sessionId: 'test-session',
      cwd: '/test',
      logger: noopLogger,
      bus,
      maxExploreSteps: 5,
    });

    const result = await planner.plan('Do something');
    expect(result).not.toBeNull();
    expect(result?.plan.objective).toBe('Test objective');
  });

  it('子任务状态初始化为 pending', async () => {
    const planJson = JSON.stringify({
      objective: 'Test',
      tasks: [
        {
          id: '1',
          title: 'Parent task',
          acceptance: ['c1'],
          children: [
            { id: '1.1', title: 'Child task', acceptance: ['c1.1'] },
          ],
        },
      ],
      verificationCriteria: [],
    });
    const llm = new FakeLLM([
      { text: planJson, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 50 } },
    ]);
    const resolver = new FakeToolResolver();
    const bus = new EventBus();

    const planner = new Planner({
      llm,
      tools: resolver,
      permission: alwaysApprove,
      sessionId: 'test-session',
      cwd: '/test',
      logger: noopLogger,
      bus,
      maxExploreSteps: 5,
    });

    const result = await planner.plan('Do something');
    expect(result).not.toBeNull();
    const task = result?.plan.tasks[0];
    expect(task?.status).toBe('pending');
    expect(task?.children[0]?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// readOnlyResolver 测试
// ---------------------------------------------------------------------------

describe('readOnlyResolver', () => {
  it('只返回 risk=read 的工具', () => {
    const resolver = new FakeToolResolver();
    resolver.register(new FakeTool('read_file', 'read', { ok: true, content: '' }));
    resolver.register(new FakeTool('write_file', 'write', { ok: true, content: '' }));
    resolver.register(new FakeTool('list_dir', 'read', { ok: true, content: '' }));

    const readOnly = readOnlyResolver(resolver);

    expect(readOnly.get('read_file')).toBeDefined();
    expect(readOnly.get('list_dir')).toBeDefined();
    expect(readOnly.get('write_file')).toBeUndefined();
    expect(readOnly.get('unknown')).toBeUndefined();
  });

  it('specs() 只包含只读工具', () => {
    const resolver = new FakeToolResolver();
    resolver.register(new FakeTool('read_file', 'read', { ok: true, content: '' }));
    resolver.register(new FakeTool('write_file', 'write', { ok: true, content: '' }));

    const readOnly = readOnlyResolver(resolver);
    const specs = readOnly.specs();

    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe('read_file');
  });
});
