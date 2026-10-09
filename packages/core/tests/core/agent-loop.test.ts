import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AgentLoop } from '../../src/core/agent-loop.js';
import { DEFAULT_BUDGET_LIMITS, TurnBudget } from '../../src/core/budget.js';
import type { BudgetLimits } from '../../src/core/budget.js';
import { ContextManager } from '../../src/core/context-manager.js';
import type { ContextManagerConfig } from '../../src/core/context-manager.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { AgentStatus } from '../../src/core/event-bus.js';
import type { EventStore } from '../../src/core/ports.js';
import {
  createInteractivePermission,
  createNonInteractivePermission,
  withApprovalEvents,
} from '../../src/core/permission.js';
import type { ApprovalAsk, PermissionManager } from '../../src/core/permission.js';
import { FakeLLMClient } from '../../src/llm/providers/fake.js';
import { LLMGateway } from '../../src/llm/gateway.js';
import { ModelRouter } from '../../src/router/model-router.js';
import { CostTracker } from '../../src/router/cost-tracker.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Logger } from '../../src/types/common.js';
import type {
  AgentEvent,
  EventEnvelope,
  ToolCall,
  TurnEndReason,
  Usage,
} from '../../src/types/events.js';
import { TransientError, formatToolError, isTransientError } from '../../src/types/errors.js';
import type { ChatResponse, LLMClient } from '../../src/types/llm.js';
import type { ExecutionContext, Tool } from '../../src/types/tools.js';

const SILENT_LOGGER: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** 内存事件存储：同步实现 async 端口（与 SQLite 实现行为对齐） */
class MemoryEventStore implements EventStore {
  readonly events: EventEnvelope[] = [];
  private nextId = 0;

  append(sessionId: string, payload: AgentEvent): Promise<EventEnvelope> {
    this.nextId += 1;
    const envelope: EventEnvelope = {
      id: this.nextId,
      sessionId,
      seq: this.nextId,
      ts: new Date().toISOString(),
      payload,
    };
    this.events.push(envelope);
    return Promise.resolve(envelope);
  }

  replay(sessionId: string): Promise<EventEnvelope[]> {
    return Promise.resolve(this.events.filter((e) => e.sessionId === sessionId));
  }

  lastSeq(sessionId: string): Promise<number> {
    const last = this.events.filter((e) => e.sessionId === sessionId).at(-1);
    return Promise.resolve(last?.seq ?? 0);
  }

  deleteFrom(sessionId: string, fromSeq: number): Promise<number> {
    const kept = this.events.filter((e) => e.sessionId !== sessionId || e.seq < fromSeq);
    const removed = this.events.length - kept.length;
    this.events.length = 0;
    this.events.push(...kept);
    return Promise.resolve(removed);
  }
}

function resp(
  text: string,
  toolCalls: ToolCall[] = [],
  usage: Usage = { inputTokens: 10, outputTokens: 5 },
): ChatResponse {
  return { text, toolCalls, stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn', usage };
}

function call(callId: string, toolName: string, args: Record<string, unknown> = {}): ToolCall {
  return { callId, toolName, args };
}

function makeTool(name: string, risk: Tool['risk'] = 'read', run?: Tool['run']): Tool {
  return {
    name,
    description: `test tool ${name}`,
    risk,
    inputSchema: z.object({ text: z.string().optional() }),
    run: run ?? ((args: unknown) => Promise.resolve({ ok: true, content: JSON.stringify(args) })),
  };
}

interface BusRecording {
  events: EventEnvelope[];
  deltas: string[];
  statuses: AgentStatus[];
  turns: { reason: TurnEndReason; usage: Usage }[];
}

function recordBus(bus: EventBus): BusRecording {
  const rec: BusRecording = { events: [], deltas: [], statuses: [], turns: [] };
  bus.on('event', (envelope) => rec.events.push(envelope));
  bus.on('llm_delta', (delta) => rec.deltas.push(delta));
  bus.on('status', (snapshot) => rec.statuses.push(snapshot));
  bus.on('turn_completed', (turn) => rec.turns.push(turn));
  return rec;
}

interface LoopOptions {
  script: ChatResponse[];
  llm?: LLMClient;
  tools?: Tool[];
  permission?: PermissionManager;
  /** 提供时用交互式权限 + 审批事件装饰（sink 直接写测试存储） */
  ask?: ApprovalAsk;
  contextConfig?: ContextManagerConfig;
  budgetLimits?: Partial<BudgetLimits>;
  /** 写前快照回调；提供时注入 AgentLoop.checkpoint */
  checkpoint?: {
    snapshotBeforeWrite: (relPath: string, seq: number) => Promise<string>;
  };
}

interface LoopHarness {
  loop: AgentLoop;
  store: MemoryEventStore;
  fake: FakeLLMClient;
  bus: EventBus;
  rec: BusRecording;
  contextConfig: ContextManagerConfig;
  costTracker: CostTracker;
}

function makeLoop(options: LoopOptions): LoopHarness {
  const store = new MemoryEventStore();
  const fake = new FakeLLMClient(options.script);
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  const bus = new EventBus();
  const rec = recordBus(bus);
  const permission =
    options.permission ??
    (options.ask !== undefined
      ? createInteractivePermission(
          withApprovalEvents(options.ask, (event) => store.append('s1', event)),
        )
      : createNonInteractivePermission());
  const contextConfig = options.contextConfig ?? { contextWindow: 100_000 };
  const client = options.llm ?? fake;
  const gateway = new LLMGateway(new Map([[client.name, client]]), { defaultProvider: client.name });
  const router = new ModelRouter(gateway, {});
  const costTracker = new CostTracker();
  const loop = new AgentLoop({
    sessionId: 's1',
    cwd: process.cwd(),
    router,
    costTracker,
    store,
    tools: registry,
    permission,
    budget: new TurnBudget({ ...DEFAULT_BUDGET_LIMITS, ...options.budgetLimits }),
    context: new ContextManager(contextConfig),
    bus,
    sandbox: {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      readFile: async () => Buffer.from(''),
      writeFile: async () => {},
      listDir: async () => [],
      getStatus: () => 'ready' as const,
      destroy: async () => {},
    },
    systemPrompt: 'You are yo.',
    maxTokens: 1024,
    logger: SILENT_LOGGER,
    ...(options.checkpoint !== undefined ? { checkpoint: options.checkpoint } : {}),
  });
  return { loop, store, fake, bus, rec, contextConfig, costTracker };
}

function types(events: EventEnvelope[]): string[] {
  return events.map((e) => e.payload.type);
}

describe('AgentLoop', () => {
  it('纯文本：一次 LLM 调用后 done，事件序列与 §5.1 一致', async () => {
    const { loop, store, fake, rec } = makeLoop({ script: [resp('hello there')] });

    const reason = await loop.runTurn('hi');

    expect(reason).toBe('done');
    expect(fake.consumed).toBe(1);
    expect(types(store.events)).toEqual([
      'turn_started',
      'user_input',
      'assistant_text',
      'turn_completed',
    ]);
    const completed = store.events[3]?.payload;
    if (completed?.type !== 'turn_completed') throw new Error('expected turn_completed');
    expect(completed.reason).toBe('done');
    expect(completed.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(completed.turnId).toEqual(expect.any(String));
    // 流式增量与总线广播
    expect(rec.deltas).toEqual(['hello there']);
    expect(rec.turns).toEqual([{ reason: 'done', usage: { inputTokens: 10, outputTokens: 5 } }]);
    expect(rec.statuses).toHaveLength(1);
    expect(rec.statuses[0]).toMatchObject({ step: 1, maxSteps: 40 });
  });

  it('双工具调用后结束：callId 关联完整，第二请求携带工具结果', async () => {
    const c1 = call('c1', 'echo', { text: 'one' });
    const c2 = call('c2', 'echo', { text: 'two' });
    const { loop, store, fake, rec, contextConfig } = makeLoop({
      script: [resp('', [c1, c2]), resp('all done')],
      tools: [makeTool('echo')],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    expect(fake.consumed).toBe(2);
    expect(types(store.events)).toEqual([
      'turn_started',
      'user_input',
      'assistant_text',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'assistant_text',
      'turn_completed',
    ]);
    // callId 关联：tool_call 与 tool_result 成对
    const tc = store.events[3]?.payload;
    if (tc?.type !== 'tool_call') throw new Error('expected tool_call');
    expect(tc).toMatchObject({ callId: 'c1', toolName: 'echo', args: { text: 'one' } });
    const tr = store.events[4]?.payload;
    if (tr?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(tr).toMatchObject({ callId: 'c1', ok: true, content: '{"text":"one"}' });
    // 第二次请求：user → assistant(toolCalls) → 工具结果成组
    expect(fake.requests[1]?.messages).toEqual([
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [c1, c2] },
      { role: 'tool', callId: 'c1', text: '{"text":"one"}' },
      { role: 'tool', callId: 'c2', text: '{"text":"two"}' },
    ]);
    // 系统提示与工具规格下发
    expect(fake.requests[0]?.system).toBe('You are yo.');
    expect(fake.requests[0]?.tools).toEqual([
      { name: 'echo', description: 'test tool echo', inputSchema: expect.any(Object) },
    ]);
    expect(rec.deltas).toEqual(['all done']);
    // 事件流重放 ≡ 在线投影（resume 的正确性根基）
    const rebuilt = ContextManager.fromEvents(
      store.events.map((e) => e.payload),
      contextConfig,
    );
    expect((await rebuilt.build()).messages).toEqual((await loop.context.build()).messages);
  });

  it('用户拒绝工具：审批事件成对落库，拒绝结果以 isError 回传', async () => {
    const asked: string[] = [];
    const ask: ApprovalAsk = (request) => {
      asked.push(request.toolName);
      return Promise.resolve('no');
    };
    const { loop, store, fake } = makeLoop({
      script: [resp('', [call('c1', 'save_thing', { text: 'payload' })]), resp('after denial')],
      tools: [makeTool('save_thing', 'write')],
      ask,
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    expect(asked).toEqual(['save_thing']);
    expect(types(store.events)).toEqual([
      'turn_started',
      'user_input',
      'assistant_text',
      'tool_call',
      'approval_request',
      'approval_result',
      'tool_result',
      'assistant_text',
      'turn_completed',
    ]);
    const approvalReq = store.events[4]?.payload;
    if (approvalReq?.type !== 'approval_request') throw new Error('expected approval_request');
    expect(approvalReq).toMatchObject({ callId: 'c1', toolName: 'save_thing' });
    expect(approvalReq.summary).toBe('save_thing text=payload');
    const approvalRes = store.events[5]?.payload;
    if (approvalRes?.type !== 'approval_result') throw new Error('expected approval_result');
    expect(approvalRes).toMatchObject({ callId: 'c1', approved: false, scope: 'once' });
    const denied = store.events[6]?.payload;
    if (denied?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(denied).toMatchObject({ callId: 'c1', ok: false, content: 'User denied this action.' });
    expect(fake.requests[1]?.messages[2]).toEqual({
      role: 'tool',
      callId: 'c1',
      text: 'User denied this action.',
      isError: true,
    });
  });

  it('步数熔断：maxStepsPerTurn=2 时第三步前以 max_steps 结束', async () => {
    const { loop, store, fake } = makeLoop({
      script: [
        resp('', [call('c1', 'echo')]),
        resp('', [call('c2', 'echo')]),
        resp('never reached'),
      ],
      tools: [makeTool('echo')],
      budgetLimits: { maxStepsPerTurn: 2 },
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('max_steps');
    expect(fake.consumed).toBe(2);
    expect(types(store.events)).toEqual([
      'turn_started',
      'user_input',
      'assistant_text',
      'tool_call',
      'tool_result',
      'assistant_text',
      'tool_call',
      'tool_result',
      'turn_completed',
    ]);
    const completed = store.events.at(-1)?.payload;
    if (completed?.type !== 'turn_completed') throw new Error('expected turn_completed');
    expect(completed.reason).toBe('max_steps');
  });

  it('中断：工具结束后、下一次 LLM 调用前生效', async () => {
    const ref: { loop?: AgentLoop } = {};
    const poke = makeTool('poke', 'read', () => {
      ref.loop?.interrupt();
      return Promise.resolve({ ok: true, content: 'poked' });
    });
    const { loop, store, fake } = makeLoop({
      script: [resp('', [call('c1', 'poke')]), resp('never reached')],
      tools: [poke],
    });
    ref.loop = loop;

    const reason = await loop.runTurn('go');

    expect(reason).toBe('interrupted');
    expect(fake.consumed).toBe(1);
    expect(types(store.events)).toEqual([
      'turn_started',
      'user_input',
      'assistant_text',
      'tool_call',
      'tool_result',
      'turn_completed',
    ]);
    const completed = store.events.at(-1)?.payload;
    if (completed?.type !== 'turn_completed') throw new Error('expected turn_completed');
    expect(completed.reason).toBe('interrupted');
  });

  it('LLM 失败：error 事件 stage=llm 且不可恢复，usage 归零', async () => {
    const { loop, store, rec } = makeLoop({ script: [] });

    const reason = await loop.runTurn('hi');

    expect(reason).toBe('error');
    expect(types(store.events)).toEqual(['turn_started', 'user_input', 'error', 'turn_completed']);
    const errEvent = store.events[2]?.payload;
    if (errEvent?.type !== 'error') throw new Error('expected error event');
    expect(errEvent.stage).toBe('llm');
    expect(errEvent.recoverable).toBe(false);
    expect(errEvent.message).toContain('script exhausted');
    expect(rec.turns).toEqual([{ reason: 'error', usage: { inputTokens: 0, outputTokens: 0 } }]);
  });

  it('TransientError：error 事件标记 recoverable（网关层负责退避重试）', async () => {
    const flux: LLMClient = {
      name: 'flux',
      chat: () => Promise.reject(new TransientError('flux')),
    };
    const { loop, store } = makeLoop({ script: [], llm: flux });

    const reason = await loop.runTurn('hi');

    expect(reason).toBe('error');
    const errEvent = store.events[2]?.payload;
    if (errEvent?.type !== 'error') throw new Error('expected error event');
    expect(errEvent.stage).toBe('llm');
    expect(errEvent.recoverable).toBe(true);
  });

  it('上下文裁剪：超预算时在 LLM 调用前落 context_elided', async () => {
    const { loop, store, fake } = makeLoop({
      script: [
        resp('', [call('c1', 'echo', { text: 'x'.repeat(2_000) })]),
        resp('', [call('c2', 'echo', { text: 'y'.repeat(2_000) })]),
        resp('summarized'),
      ],
      tools: [makeTool('echo')],
      contextConfig: {
        contextWindow: 600,
        keepRecent: 1,
        outputReserveTokens: 0,
        toolsSystemReserveTokens: 0,
        bodyTargetRatio: 1,
      },
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    expect(types(store.events)).toEqual([
      'turn_started',
      'user_input',
      'assistant_text',
      'tool_call',
      'tool_result',
      'assistant_text',
      'tool_call',
      'tool_result',
      'context_elided',
      'assistant_text',
      'turn_completed',
    ]);
    const elided = store.events[8]?.payload;
    if (elided?.type !== 'context_elided') throw new Error('expected context_elided');
    expect(elided.count).toBeGreaterThanOrEqual(1);
    expect(elided.freedEstTokens).toBeGreaterThan(0);
    // 第三次请求里，非保留的第一个工具结果已被占位符替换
    const thirdToolMsg = fake.requests[2]?.messages[2];
    expect(thirdToolMsg).toMatchObject({ role: 'tool', callId: 'c1' });
    if (thirdToolMsg?.role !== 'tool') throw new Error('expected tool message');
    expect(thirdToolMsg.text).toContain('[tool result elided');
  });

  it('写前快照：注入 checkpoint 后 tool.run 收到 snapshotBeforeWrite + 正确 seq', async () => {
    const snapshotCalls: { relPath: string; seq: number }[] = [];
    let capturedCtx: ExecutionContext | undefined;
    const writer = makeTool('writer', 'write', (_args, ctx) => {
      capturedCtx = ctx;
      return Promise.resolve({ ok: true, content: 'wrote' });
    });
    const { loop, store } = makeLoop({
      script: [resp('', [call('c1', 'writer')]), resp('done')],
      tools: [writer],
      // 放行 write，使工具真正执行、ctx 被捕获
      permission: createNonInteractivePermission({ mode: 'full', shellMode: 'ask', shellAllowlist: [] }),
      checkpoint: {
        snapshotBeforeWrite: async (relPath, seq) => {
          snapshotCalls.push({ relPath, seq });
          return 'cp-1';
        },
      },
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    // tool_call 事件序号 = turn_started(1) + user_input(2) + assistant_text(3) + tool_call(4)
    const toolCallEvent = store.events.find((e) => e.payload.type === 'tool_call');
    expect(toolCallEvent).toBeDefined();
    expect(capturedCtx?.currentSeq).toBe(toolCallEvent?.seq);
    expect(capturedCtx?.snapshotBeforeWrite).toBeTypeOf('function');

    // 触发快照回调，验证 relPath 与 seq 透传
    await capturedCtx!.snapshotBeforeWrite!('a.txt');
    expect(snapshotCalls).toEqual([{ relPath: 'a.txt', seq: toolCallEvent?.seq }]);
  });

  it('max_tokens 截断：丢弃工具调用、注入续写并从截断处继续', async () => {
    const { loop, store } = makeLoop({
      script: [
        { text: 'part 1', toolCalls: [], stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 5 } },
        { text: 'part 2', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    const assistantTexts = store.events.filter((e) => e.payload.type === 'assistant_text');
    expect(assistantTexts).toHaveLength(2);
    const continuation = store.events.find(
      (e) =>
        e.payload.type === 'user_input' &&
        (e.payload as { content: string }).content.includes('max_tokens'),
    );
    expect(continuation).toBeDefined();
  });

  it('max_tokens 连续截断：续写 3 次后熔断收尾', async () => {
    const truncated: ChatResponse = {
      text: 'x',
      toolCalls: [],
      stopReason: 'max_tokens',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const { loop, store } = makeLoop({
      script: [truncated, truncated, truncated, truncated, truncated],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    const continuations = store.events.filter(
      (e) =>
        e.payload.type === 'user_input' &&
        (e.payload as { content: string }).content.includes('max_tokens'),
    );
    // MAX_CONTINUATIONS=3：第 1-3 次截断各续写一次，第 4 次截断熔断
    expect(continuations).toHaveLength(3);
  });

  it('未知工具：ok=false 结果回传，回合继续', async () => {
    const { loop, store, fake } = makeLoop({
      script: [resp('', [call('c1', 'nope')]), resp('recovered')],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    const tr = store.events[4]?.payload;
    if (tr?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(tr).toMatchObject({ callId: 'c1', ok: false, content: 'unknown tool: nope' });
    expect(fake.requests[1]?.messages[2]).toEqual({
      role: 'tool',
      callId: 'c1',
      text: 'unknown tool: nope',
      isError: true,
    });
  });

  it('工具违约 throw：降级为 ok=false 的 tool_result，回合继续', async () => {
    const boom = makeTool('boom', 'read', () => Promise.reject(new Error('boom internals')));
    const { loop, store } = makeLoop({
      script: [resp('', [call('c1', 'boom')]), resp('recovered')],
      tools: [boom],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    const tr = store.events[4]?.payload;
    if (tr?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(tr.ok).toBe(false);
    expect(tr.content).toContain('tool crashed');
    expect(tr.content).toContain('boom internals');
  });

  it('瞬态错误自动重试：前 2 次失败，第 3 次成功 → 最终 ok=true', async () => {
    let attempts = 0;
    const flaky = makeTool('flaky', 'read', () => {
      attempts++;
      if (attempts <= 2) {
        return Promise.resolve({
          ok: false,
          content: formatToolError({
            kind: 'transient',
            message: 'network timeout',
          }),
        });
      }
      return Promise.resolve({ ok: true, content: 'success' });
    });
    const { loop, store } = makeLoop({
      script: [resp('', [call('c1', 'flaky')]), resp('done')],
      tools: [flaky],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    expect(attempts).toBe(3);
    const tr = store.events[4]?.payload;
    if (tr?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(tr.ok).toBe(true);
    expect(tr.content).toBe('success');
  });

  it('瞬态错误重试用尽：3 次全失败 → 最终 ok=false，content 含重试次数', async () => {
    let attempts = 0;
    const alwaysFail = makeTool('always_fail', 'read', () => {
      attempts++;
      return Promise.resolve({
        ok: false,
        content: formatToolError({
          kind: 'transient',
          message: 'persistent failure',
        }),
      });
    });
    const { loop, store } = makeLoop({
      script: [resp('', [call('c1', 'always_fail')]), resp('done')],
      tools: [alwaysFail],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    expect(attempts).toBe(4); // 1 initial + 3 retries
    const tr = store.events[4]?.payload;
    if (tr?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(tr.ok).toBe(false);
    expect(tr.content).toContain('[TRANSIENT]');
    expect(tr.content).toContain('Retries: 3/3');
  });

  it('参数错误不重试：直接返回 [PARAMETER]', async () => {
    let attempts = 0;
    const paramError = makeTool('param_err', 'read', () => {
      attempts++;
      return Promise.resolve({
        ok: false,
        content: formatToolError({
          kind: 'parameter',
          message: 'invalid path',
          validationDetails: 'path must be absolute',
        }),
      });
    });
    const { loop, store } = makeLoop({
      script: [resp('', [call('c1', 'param_err')]), resp('done')],
      tools: [paramError],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    expect(attempts).toBe(1); // 不重试
    const tr = store.events[4]?.payload;
    if (tr?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(tr.ok).toBe(false);
    expect(tr.content).toContain('[PARAMETER]');
    expect(tr.content).toContain('invalid path');
  });

  it('致命错误不重试：直接返回 [FATAL]', async () => {
    let attempts = 0;
    const fatal = makeTool('fatal', 'read', () => {
      attempts++;
      return Promise.resolve({
        ok: false,
        content: formatToolError({
          kind: 'fatal',
          message: 'unrecoverable state',
        }),
      });
    });
    const { loop, store } = makeLoop({
      script: [resp('', [call('c1', 'fatal')]), resp('done')],
      tools: [fatal],
    });

    const reason = await loop.runTurn('go');

    expect(reason).toBe('done');
    expect(attempts).toBe(1); // 不重试
    const tr = store.events[4]?.payload;
    if (tr?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(tr.ok).toBe(false);
    expect(tr.content).toContain('[FATAL]');
  });
});

describe('formatToolError', () => {
  it('transient 格式正确', () => {
    const result = formatToolError({
      kind: 'transient',
      message: 'network timeout',
      suggestion: 'retry later',
      retryCount: 2,
    });
    expect(result).toContain('[TRANSIENT]');
    expect(result).toContain('network timeout');
    expect(result).toContain('Suggestion: retry later');
    expect(result).toContain('Retries: 2/3');
  });

  it('parameter 格式正确', () => {
    const result = formatToolError({
      kind: 'parameter',
      message: 'invalid args',
      validationDetails: 'missing required field',
    });
    expect(result).toContain('[PARAMETER]');
    expect(result).toContain('invalid args');
    expect(result).toContain('Details: missing required field');
  });

  it('fatal 格式正确', () => {
    const result = formatToolError({
      kind: 'fatal',
      message: 'disk corrupted',
    });
    expect(result).toContain('[FATAL]');
    expect(result).toContain('disk corrupted');
  });
});

describe('isTransientError', () => {
  it('检测 [TRANSIENT] 前缀', () => {
    expect(isTransientError('[TRANSIENT] network timeout')).toBe(true);
    expect(isTransientError('[PARAMETER] invalid args')).toBe(false);
    expect(isTransientError('[FATAL] disk corrupted')).toBe(false);
    expect(isTransientError('some other error')).toBe(false);
  });
});
