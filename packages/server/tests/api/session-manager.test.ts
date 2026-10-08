/**
 * SessionManager 单元测试：审批机制 + 生命周期管理。
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
import type { SessionManagerDeps } from '../../src/session-manager.js';

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
