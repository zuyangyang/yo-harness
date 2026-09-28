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

function createDeps(): SessionManagerDeps {
  const fakeClient = new FakeLLMClient([
    { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
  ]);
  const gateway = new LLMGateway(new Map([['fake', fakeClient]]), { defaultProvider: 'fake' });
  const router = new ModelRouter(gateway, {});

  return {
    eventStore: storage.events,
    sessionStore: storage.sessions,
    tools: createBuiltinRegistry(),
    router,
    costTracker: new CostTracker(),
    sandbox: createLocalSandbox('/tmp'),
    logger: createLogger('silent'),
    systemPrompt: 'test',
    maxTokens: 1024,
    contextWindow: 4096,
    budgetLimits: DEFAULT_BUDGET_LIMITS,
    permission: DEFAULT_PERMISSION_SETTINGS,
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
