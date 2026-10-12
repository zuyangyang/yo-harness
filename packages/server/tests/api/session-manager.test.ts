/**
 * SessionManager 单元测试：审批机制 + 生命周期管理。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSqliteBackend } from '../../src/storage/sqlite.js';
import type { StorageBackend } from '../../src/storage/interface.js';
import { SessionManager } from '../../src/session-manager.js';
import { CostTracker } from '@yo-harness/core/router/cost-tracker.js';
import { ModelRouter } from '@yo-harness/core/router/model-router.js';
import { LLMGateway } from '@yo-harness/core/llm/gateway.js';
import { FakeLLMClient } from '@yo-harness/core/llm/providers/fake.js';
import { createBuiltinRegistry } from '@yo-harness/core/tools/registry.js';
import { createLogger } from '@yo-harness/core/utils/logger.js';
import { DEFAULT_BUDGET_LIMITS } from '@yo-harness/core/core/budget.js';
import { DEFAULT_PERMISSION_SETTINGS } from '@yo-harness/core/core/permission.js';
import { createLocalSandbox } from '@yo-harness/core/sandbox/local-sandbox.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config.js';
import type { SessionManagerDeps } from '../../src/session-manager.js';
import type { WebSocketHub } from '../../src/ws/hub.js';
import type { ChatResponse } from '@yo-harness/core/types/llm.js';

let storage: StorageBackend;
let manager: SessionManager;

function createDeps(overrides: Partial<SessionManagerDeps> = {}): SessionManagerDeps {
  const fakeClient = new FakeLLMClient([
    { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
  ]);
  const gateway = new LLMGateway(new Map([['fake', fakeClient]]), { defaultProvider: 'fake' });
  const router = new ModelRouter(gateway, {});

  return {
    eventStore: storage.events,
    sessionStore: storage.sessions,
    tools: createBuiltinRegistry(),
    resolveRuntime: async () => ({ router, contextWindow: 4096, model: 'fake' }),
    costTracker: new CostTracker(),
    sandbox: createLocalSandbox('/tmp'),
    logger: createLogger('silent'),
    memoryStore: storage.memories,
    memoryConfig: DEFAULT_MEMORY_CONFIG,
    systemPrompt: 'test',
    maxTokens: 1024,
    budgetLimits: DEFAULT_BUDGET_LIMITS,
    permission: DEFAULT_PERMISSION_SETTINGS,
    ...overrides,
  };
}

beforeEach(async () => {
  storage = createSqliteBackend(':memory:');
  await storage.initialize();
  manager = new SessionManager(createDeps());
});

describe('SessionManager lifecycle', () => {
  it('getPendingApprovals 未知 session → 空列表', () => {
    expect(manager.getPendingApprovals('nonexistent')).toEqual([]);
  });

  it('resolveApproval 未知 id → false', () => {
    expect(manager.resolveApproval('nonexistent', true)).toBe(false);
  });

  it('closeSession 未知 session 不抛异常', () => {
    expect(() => manager.closeSession('nonexistent')).not.toThrow();
  });

  it('destroyAll 空状态不抛异常', async () => {
    await expect(manager.destroyAll()).resolves.not.toThrow();
  });

  it('interrupt 未知 session 不抛异常', async () => {
    await expect(manager.interrupt('nonexistent')).resolves.not.toThrow();
  });
});

function routerWith(text: string): ModelRouter {
  const client = new FakeLLMClient([
    { text, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const gateway = new LLMGateway(new Map([['fake', client]]), { defaultProvider: 'fake' });
  return new ModelRouter(gateway, {});
}

function routerFromScript(script: ChatResponse[]): ModelRouter {
  const client = new FakeLLMClient(script);
  const gateway = new LLMGateway(new Map([['fake', client]]), { defaultProvider: 'fake' });
  return new ModelRouter(gateway, {});
}

async function waitForPending(
  m: SessionManager,
  sessionId: string,
  timeoutMs = 3000,
): Promise<{ id: string }[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = m.getPendingApprovals(sessionId);
    if (pending.length > 0) return pending;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for a pending approval');
}

async function assistantTexts(sessionId: string): Promise<string[]> {
  const events = await storage.events.replay(sessionId);
  return events.map((e) => e.payload).flatMap((p) => (p.type === 'assistant_text' ? [p.text] : []));
}

/** 轮询直到空闲会话被驱逐（turn 结束后 running 才会变 false） */
async function waitForEviction(m: SessionManager, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evicted = m.onModelConfigChanged();
    if (evicted > 0) return evicted;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('session was never evicted after its turn finished');
}

async function waitForAssistantText(sessionId: string, count: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await assistantTexts(sessionId)).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} assistant_text events`);
}

async function waitForMemoryExtracted(sessionId: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await storage.events.replay(sessionId);
    if (events.some((e) => e.payload.type === 'memory_extracted')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for memory_extracted');
}

async function waitForMemoryExtractedCount(
  sessionId: string,
  count: number,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await storage.events.replay(sessionId);
    if (events.filter((e) => e.payload.type === 'memory_extracted').length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} memory_extracted events`);
}

/** 等上一 turn 的 running 标记释放后再发下一条（避免 "already running a turn"） */
async function sendWhenIdle(m: SessionManager, sessionId: string, text: string): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      await m.sendMessage(sessionId, text);
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe('SessionManager 模型配置变更', () => {
  it('在途 turn 不驱逐；空闲后驱逐，下一条消息用新 router', async () => {
    let currentRouter = routerWith('first');
    manager = new SessionManager(
      createDeps({
        resolveRuntime: async () => ({ router: currentRouter, contextWindow: 4096, model: 'fake' }),
      }),
    );

    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });
    const result = await manager.sendMessage(session.id, 'hello');
    expect(result.accepted).toBe(true);

    // 正在执行 turn：running=true，不得驱逐
    expect(manager.onModelConfigChanged()).toBe(0);

    await waitForAssistantText(session.id, 1);

    // 空闲：驱逐，使下一条消息重建 loop
    expect(await waitForEviction(manager)).toBe(1);
    expect(manager.onModelConfigChanged()).toBe(0);

    currentRouter = routerWith('second');
    await manager.sendMessage(session.id, 'again');
    await waitForAssistantText(session.id, 2);
    await manager.destroyAll();

    expect((await assistantTexts(session.id)).at(-1)).toBe('second');
  });

  it('invalidateSession 只驱逐空闲会话（在途 turn 不打断）', async () => {
    manager = new SessionManager(
      createDeps({
        resolveRuntime: async () => ({ router: routerWith('ok'), contextWindow: 4096, model: 'fake' }),
      }),
    );
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'hello');
    expect(manager.invalidateSession(session.id)).toBe(false);

    await waitForAssistantText(session.id, 1);

    const deadline = Date.now() + 3000;
    let evicted = false;
    while (Date.now() < deadline && !evicted) {
      evicted = manager.invalidateSession(session.id);
      if (!evicted) await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(evicted).toBe(true);
    expect(manager.invalidateSession(session.id)).toBe(false);
  });
});

describe('SessionManager sendMessage', () => {
  it('applyPermissionMode：活跃会话返回 true，未知会话 false', async () => {
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });
    await manager.sendMessage(session.id, 'hello');
    await waitForAssistantText(session.id, 1);

    expect(manager.applyPermissionMode(session.id, 'full')).toBe(true);
    expect(manager.applyPermissionMode('nonexistent', 'full')).toBe(false);
    await manager.destroyAll();
  });

  it('不存在的 session → 抛异常', async () => {
    await expect(manager.sendMessage('nonexistent', 'hello')).rejects.toThrow('session not found');
  });

  it('存在的 session → accepted', async () => {
    const session = await storage.sessions.create({
      model: 'default',
      cwd: '/tmp',
      type: 'interactive',
    });
    const result = await manager.sendMessage(session.id, 'hello');
    expect(result.accepted).toBe(true);
    await manager.destroyAll();
  });
});

describe('SessionManager 审批广播', () => {
  function createHub(): WebSocketHub {
    return {
      broadcast: vi.fn(),
      broadcastDelta: vi.fn(),
      broadcastTruncated: vi.fn(),
      broadcastApprovalRequest: vi.fn(),
      broadcastApprovalResolved: vi.fn(),
      broadcastApprovalCancelled: vi.fn(),
    } as unknown as WebSocketHub;
  }

  function scriptedManager(hub: WebSocketHub): SessionManager {
    const writeCall = {
      callId: 'c1',
      toolName: 'write_file',
      args: { path: 'yo-approval-test.txt', content: 'hi' },
    };
    return new SessionManager(
      createDeps({
        wsHub: hub,
        resolveRuntime: async () => ({
          router: routerFromScript([
            { text: '', toolCalls: [writeCall], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
            { text: 'done', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
          ]),
          contextWindow: 4096,
          model: 'fake',
        }),
      }),
    );
  }

  it('serverAsk 广播审批请求；resolveApproval 广播已决', async () => {
    const hub = createHub();
    manager = scriptedManager(hub);
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, '写一个文件');

    const pending = await waitForPending(manager, session.id);
    expect(pending).toHaveLength(1);
    expect(hub.broadcastApprovalRequest).toHaveBeenCalledWith(session.id, pending[0]);

    expect(manager.resolveApproval(pending[0]!.id, true, 'once')).toBe(true);
    expect(hub.broadcastApprovalResolved).toHaveBeenCalledWith(session.id, pending[0]!.id, 'once', 'user');
    await manager.destroyAll();
  });

  it('会话 permissionMode=full → 写操作自动放行，不产生 pending', async () => {
    const hub = createHub();
    manager = scriptedManager(hub);
    const session = await storage.sessions.create({
      model: 'm',
      cwd: '/tmp',
      type: 'interactive',
      permissionMode: 'full',
    });

    await manager.sendMessage(session.id, '写一个文件');
    await waitForAssistantText(session.id, 2);

    expect(manager.getPendingApprovals(session.id)).toEqual([]);
    expect(hub.broadcastApprovalRequest).not.toHaveBeenCalled();
    await manager.destroyAll();
  });

  it('interrupt 唤醒阻塞在审批上的循环并广播 cancelled', async () => {
    const hub = createHub();
    manager = scriptedManager(hub);
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, '写一个文件');
    const pending = await waitForPending(manager, session.id);

    await manager.interrupt(session.id);

    expect(hub.broadcastApprovalCancelled).toHaveBeenCalledWith(
      session.id,
      pending[0]!.id,
      'session closed or interrupted',
    );
    expect(manager.getPendingApprovals(session.id)).toEqual([]);
    // 中断后循环应结束：出现 turn_completed
    const deadline = Date.now() + 3000;
    let ended = false;
    while (Date.now() < deadline && !ended) {
      const events = await storage.events.replay(session.id);
      ended = events.some((ev) => ev.payload.type === 'turn_completed');
      if (!ended) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ended).toBe(true);
    await manager.destroyAll();
  });

  it('closeSession 取消未决审批并广播 cancelled', async () => {
    const hub = createHub();
    manager = scriptedManager(hub);
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, '写一个文件');
    const pending = await waitForPending(manager, session.id);

    manager.closeSession(session.id);
    expect(hub.broadcastApprovalCancelled).toHaveBeenCalledWith(
      session.id,
      pending[0]!.id,
      'session closed or interrupted',
    );
    expect(manager.getPendingApprovals(session.id)).toEqual([]);
    await manager.destroyAll();
  });
});

describe('SessionManager 回退（重新生成 / 编辑重发）', () => {
  function createHub(): WebSocketHub {
    return {
      broadcast: vi.fn(),
      broadcastDelta: vi.fn(),
      broadcastTruncated: vi.fn(),
      broadcastApprovalRequest: vi.fn(),
      broadcastApprovalResolved: vi.fn(),
      broadcastApprovalCancelled: vi.fn(),
    } as unknown as WebSocketHub;
  }

  /**
   * 同一个 router 内两次脚本消费：首次 'first'，回退重跑 'second'。
   * router 必须在 resolveRuntime 之外只建一次——回退会驱逐并重建 loop，
   * 若每次重建都新建 router，FakeLLMClient 的游标会重置回第一条。
   */
  function twoTurnManager(overrides: Partial<SessionManagerDeps> = {}): SessionManager {
    const router = routerFromScript([
      { text: 'first', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'second', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    return new SessionManager(
      createDeps({
        resolveRuntime: async () => ({ router, contextWindow: 4096, model: 'fake' }),
        ...overrides,
      }),
    );
  }

  it('regenerateTurn 删除旧回复、保留同一 user 消息并重新生成', async () => {
    const hub = createHub();
    manager = twoTurnManager({ wsHub: hub });
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'hello');
    await waitForAssistantText(session.id, 1);
    expect(await assistantTexts(session.id)).toEqual(['first']);
    await waitForEviction(manager);

    const result = await manager.regenerateTurn(session.id);
    expect(result.accepted).toBe(true);
    expect(hub.broadcastTruncated).toHaveBeenCalledWith(session.id, result.fromSeq);

    await waitForAssistantText(session.id, 1);
    expect(await assistantTexts(session.id)).toEqual(['second']);

    const userInputs = (await storage.events.replay(session.id)).filter(
      (e) => e.payload.type === 'user_input',
    );
    expect(userInputs).toHaveLength(1);
    expect((userInputs[0]!.payload as { content: string }).content).toBe('hello');
    await manager.destroyAll();
  });

  it('editTurn 用新内容替换 user 消息并重发', async () => {
    manager = twoTurnManager();
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });
    await manager.sendMessage(session.id, 'hello');
    await waitForAssistantText(session.id, 1);
    await waitForEviction(manager);

    const seq = (await storage.events.replay(session.id)).find(
      (e) => e.payload.type === 'user_input',
    )!.seq;
    const result = await manager.editTurn(session.id, seq, 'edited');
    expect(result.fromSeq).toBe(seq);

    await waitForAssistantText(session.id, 1);
    expect(await assistantTexts(session.id)).toEqual(['second']);

    const userInputs = (await storage.events.replay(session.id)).filter(
      (e) => e.payload.type === 'user_input',
    );
    expect(userInputs).toHaveLength(1);
    expect((userInputs[0]!.payload as { content: string }).content).toBe('edited');
    await manager.destroyAll();
  });

  it('无 user 消息 / 未知 seq / 空编辑内容 → 抛错', async () => {
    manager = twoTurnManager();
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await expect(manager.regenerateTurn(session.id)).rejects.toThrow('no user message to regenerate');
    await expect(manager.editTurn(session.id, 999, 'x')).rejects.toThrow(
      'user message not found at seq 999',
    );
    await expect(manager.editTurn(session.id, 1, '   ')).rejects.toThrow(
      'content must not be empty',
    );
  });

  it('在途 turn 时 regenerateTurn / editTurn 拒绝执行', async () => {
    manager = new SessionManager(
      createDeps({
        resolveRuntime: async () => ({
          router: routerWith('ok'),
          contextWindow: 4096,
          model: 'fake',
        }),
      }),
    );
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'hello');
    await expect(manager.regenerateTurn(session.id)).rejects.toThrow('already running');
    await expect(manager.editTurn(session.id, 1, 'x')).rejects.toThrow('already running');
    await manager.destroyAll();
  });
});

describe('SessionManager 记忆注入', () => {
  it('新 turn 注入 active 记忆并落 memory_injected 事件', async () => {
    await storage.memories.create({
      title: 'Prefers strict TS',
      content: 'User always enables strict mode',
      category: 'preference',
      description: 'strict TS',
      keywords: ['typescript'],
      status: 'active',
    });

    const client = new FakeLLMClient([
      { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const gateway = new LLMGateway(new Map([['fake', client]]), { defaultProvider: 'fake' });
    const router = new ModelRouter(gateway, {});
    manager = new SessionManager(
      createDeps({
        resolveRuntime: async () => ({ router, contextWindow: 4096, model: 'fake' }),
      }),
    );
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'hello');
    await waitForAssistantText(session.id, 1);

    expect(client.requests[0]?.system).toContain('<semantic-memory>');
    expect(client.requests[0]?.system).toContain('Prefers strict TS');
    const injected = (await storage.events.replay(session.id)).find(
      (e) => e.payload.type === 'memory_injected',
    );
    expect(injected).toBeDefined();
    await manager.destroyAll();
  });

  it('autoInject=false 时不注入记忆', async () => {
    await storage.memories.create({
      title: 'Prefers strict TS',
      content: 'User always enables strict mode',
      category: 'preference',
      description: 'strict TS',
      keywords: ['typescript'],
      status: 'active',
    });

    const client = new FakeLLMClient([
      { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const gateway = new LLMGateway(new Map([['fake', client]]), { defaultProvider: 'fake' });
    const router = new ModelRouter(gateway, {});
    manager = new SessionManager(
      createDeps({
        memoryConfig: { ...DEFAULT_MEMORY_CONFIG, autoInject: false },
        resolveRuntime: async () => ({ router, contextWindow: 4096, model: 'fake' }),
      }),
    );
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'hello');
    await waitForAssistantText(session.id, 1);

    expect(client.requests[0]?.system).toBe('test');
    const injected = (await storage.events.replay(session.id)).find(
      (e) => e.payload.type === 'memory_injected',
    );
    expect(injected).toBeUndefined();
    await manager.destroyAll();
  });
});

describe('SessionManager 记忆提取', () => {
  function extractionManager(
    scriptTexts: string[],
    memoryConfig = DEFAULT_MEMORY_CONFIG,
  ): { manager: SessionManager; client: FakeLLMClient } {
    const script = scriptTexts.map((text) => ({
      text,
      toolCalls: [],
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const client = new FakeLLMClient(script);
    const gateway = new LLMGateway(new Map([['fake', client]]), { defaultProvider: 'fake' });
    const router = new ModelRouter(gateway, {});
    const m = new SessionManager(
      createDeps({
        memoryConfig,
        resolveRuntime: async () => ({ router, contextWindow: 4096, model: 'fake' }),
      }),
    );
    return { manager: m, client };
  }

  it('turn 结束后自动提取并写入记忆 + 落 memory_extracted', async () => {
    const extractionJson = JSON.stringify({
      memories: [
        {
          title: 'Uses vitest',
          content: 'Project tests with vitest',
          category: 'project_knowledge',
          description: 'test runner',
          keywords: ['vitest'],
        },
      ],
    });
    const { manager: m } = extractionManager(['ok', extractionJson], {
      ...DEFAULT_MEMORY_CONFIG,
      extractMinChars: 10,
    });
    manager = m;
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'we use vitest for this project');
    await waitForAssistantText(session.id, 1);
    await waitForMemoryExtracted(session.id);

    const memories = await storage.memories.listActive();
    expect(memories.map((memory) => memory.title)).toContain('Uses vitest');
    expect(memories[0]?.sourceSessionId).toBe(session.id);
    await manager.destroyAll();
  });

  it('价值闸门：低重要度候选被丢弃，高重要度保留', async () => {
    const extractionJson = JSON.stringify({
      memories: [
        {
          title: 'Low value note',
          content: 'drop me',
          category: 'general',
          description: 'd',
          keywords: ['low'],
          importance: 2,
          durability: 'durable',
        },
        {
          title: 'Valuable note',
          content: 'keep me',
          category: 'project_knowledge',
          description: 'd',
          keywords: ['valuable'],
          importance: 8,
          durability: 'durable',
        },
      ],
    });
    const { manager: m } = extractionManager(['ok', extractionJson], {
      ...DEFAULT_MEMORY_CONFIG,
      extractMinChars: 10,
      minImportance: 4,
    });
    manager = m;
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'we use vitest for this project');
    await waitForAssistantText(session.id, 1);
    await waitForMemoryExtracted(session.id);

    const titles = (await storage.memories.listActive()).map((memory) => memory.title);
    expect(titles).toContain('Valuable note');
    expect(titles).not.toContain('Low value note');
    await manager.destroyAll();
  });

  it('同一稳定槽位再次提取 → 覆盖同一行而不是追加（记忆自动更新）', async () => {
    const firstJson = JSON.stringify({
      memories: [
        {
          title: 'User name',
          content: 'The user name is yang',
          category: 'general',
          description: 'user name',
          keywords: ['name'],
          importance: 9,
          durability: 'durable',
          key: 'profile.name',
        },
      ],
    });
    const secondJson = JSON.stringify({
      memories: [
        {
          title: 'User name',
          content: 'The user name is Yang Yang',
          category: 'general',
          description: 'user name',
          keywords: ['name'],
          importance: 9,
          durability: 'durable',
          key: 'profile.name',
        },
      ],
    });
    const { manager: m } = extractionManager(['ok', firstJson, 'ok', secondJson], {
      ...DEFAULT_MEMORY_CONFIG,
      extractMinChars: 10,
    });
    manager = m;
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'my name is yang, remember it');
    await waitForAssistantText(session.id, 1);
    await waitForMemoryExtractedCount(session.id, 1);

    await sendWhenIdle(manager, session.id, 'actually my name is Yang Yang');
    await waitForAssistantText(session.id, 2);
    await waitForMemoryExtractedCount(session.id, 2);

    const memories = await storage.memories.listActive();
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe('The user name is Yang Yang');
    expect(memories[0]?.key).toBe('profile.name');
    await manager.destroyAll();
  });

  it('未达字符阈值时不提取', async () => {
    const extractionJson = JSON.stringify({
      memories: [
        { title: 'Should not appear', content: 'x', category: 'general', description: 'd', keywords: ['x'] },
      ],
    });
    const { manager: m, client } = extractionManager(['ok', extractionJson], {
      ...DEFAULT_MEMORY_CONFIG,
      extractMinChars: 5_000,
      extractFlushMinChars: 5_000,
    });
    manager = m;
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'hi');
    await waitForAssistantText(session.id, 1);
    await manager.destroyAll();

    expect(client.consumed).toBe(1);
    expect(await storage.memories.listActive()).toHaveLength(0);
  });

  it('会话关闭时 flush 提取', async () => {
    const extractionJson = JSON.stringify({
      memories: [
        { title: 'Flushed memory', content: 'captured on close', category: 'general', description: 'd', keywords: ['flush'] },
      ],
    });
    const { manager: m } = extractionManager(['ok', extractionJson], {
      ...DEFAULT_MEMORY_CONFIG,
      extractMinChars: 5_000,
      extractFlushMinChars: 10,
    });
    manager = m;
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'remember this on close');
    await waitForAssistantText(session.id, 1);
    await manager.destroyAll();

    const memories = await storage.memories.listActive();
    expect(memories.map((memory) => memory.title)).toContain('Flushed memory');
  });

  it('extractMemoriesNow 对非活跃会话回放全量事件提取', async () => {
    const extractionJson = JSON.stringify({
      memories: [
        { title: 'Manual memory', content: 'manual', category: 'general', description: 'd', keywords: ['m'] },
      ],
    });
    const { manager: m } = extractionManager(['ok', extractionJson], {
      ...DEFAULT_MEMORY_CONFIG,
      extractMinChars: 5_000,
      extractFlushMinChars: 5_000,
    });
    manager = m;
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp', type: 'interactive' });

    await manager.sendMessage(session.id, 'we use vitest for this project');
    await waitForAssistantText(session.id, 1);
    manager.closeSession(session.id, { extract: false });

    const count = await manager.extractMemoriesNow(session.id);

    expect(count).toBe(1);
    const memories = await storage.memories.listActive();
    expect(memories.map((memory) => memory.title)).toContain('Manual memory');
  });
});
