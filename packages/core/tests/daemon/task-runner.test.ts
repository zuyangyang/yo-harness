import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskRunner } from '../../src/daemon/task-runner.js';
import type { Logger } from '../../src/types/common.js';
import { FakeLLMClient } from '../../src/llm/providers/fake.js';
import { LLMGateway } from '../../src/llm/gateway.js';
import { ModelRouter } from '../../src/router/model-router.js';
import { CostTracker } from '../../src/router/cost-tracker.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { openDatabase } from '../../src/storage/db.js';
import { SqliteEventStore } from '../../src/storage/event-store.js';
import { SqliteSessionStore } from '../../src/storage/session-store.js';
import { SqliteTaskStore } from '../../src/storage/task-store.js';
import type { SqliteDatabase } from '../../src/storage/db.js';

let dir: string;
let db: SqliteDatabase;
let eventStore: SqliteEventStore;
let sessionStore: SqliteSessionStore;
let taskStore: SqliteTaskStore;
let logger: Logger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-task-runner-'));
  db = openDatabase(join(dir, 'test.db'));
  eventStore = new SqliteEventStore(db);
  sessionStore = new SqliteSessionStore(db);
  taskStore = new SqliteTaskStore(db);
  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('TaskRunner', () => {
  it('fake provider → 跑完一个简单任务 → 事件写入 store → 返回 completed', async () => {
    const fakeClient = new FakeLLMClient([
      {
        text: 'I will list the files for you.',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);

    const gateway = new LLMGateway(new Map([['anthropic', fakeClient]]), { defaultProvider: 'anthropic' });
    const router = new ModelRouter(gateway, {});
    const costTracker = new CostTracker();
    const registry = new ToolRegistry();

    const runner = new TaskRunner({
      taskStore,
      sessionStore,
      eventStore,
      tools: registry,
      router,
      costTracker,
      logger,
      systemPrompt: 'You are a test assistant.',
      maxTokens: 100,
      budgetLimits: {
        maxStepsPerTurn: 10,
        maxTokensPerTurn: 10000,
        maxTurnDurationMs: 60000,
      },
      contextWindow: 100000,
    });

    const task = await taskStore.create({
      description: 'List files',
      cwd: dir,
      model: 'anthropic/test-model',
    });

    const result = await runner.run({
      taskId: task.id,
      prompt: 'List files in current directory',
      cwd: dir,
      model: 'anthropic/test-model',
    });

    expect(result.taskId).toBe(task.id);
    expect(result.endReason).toBe('done');
    expect(result.summary).toContain('list the files');

    const updatedTask = await taskStore.get(task.id);
    expect(updatedTask?.status).toBe('completed');
    expect(updatedTask?.endReason).toBe('end_turn');
    expect(updatedTask?.summary).toContain('list the files');

    const envelopes = await eventStore.replay(task.sessionId);
    expect(envelopes.length).toBeGreaterThan(0);
    const userInputs = envelopes.filter((e) => e.payload.type === 'user_input');
    expect(userInputs).toHaveLength(1);
    expect(userInputs[0]?.payload.type).toBe('user_input');
    if (userInputs[0]?.payload.type === 'user_input') {
      expect(userInputs[0].payload.content).toBe('List files in current directory');
    }
  });

  it('budget 熔断 → 返回 max_steps', async () => {
    const fakeClient = new FakeLLMClient([
      {
        text: 'Step 1',
        toolCalls: [{ callId: 'c1', toolName: 'echo', args: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 10 },
      },
      {
        text: 'Step 2',
        toolCalls: [{ callId: 'c2', toolName: 'echo', args: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 10 },
      },
      {
        text: 'Step 3 - never reached',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);

    const gateway = new LLMGateway(new Map([['anthropic', fakeClient]]), { defaultProvider: 'anthropic' });
    const router = new ModelRouter(gateway, {});
    const costTracker = new CostTracker();
    const registry = new ToolRegistry();

    // 注册一个 echo 工具
    registry.register({
      name: 'echo',
      description: 'Echo tool',
      risk: 'read',
      inputSchema: {},
      run: () => Promise.resolve({ ok: true, content: 'echo' }),
    });

    const runner = new TaskRunner({
      taskStore,
      sessionStore,
      eventStore,
      tools: registry,
      router,
      costTracker,
      logger,
      systemPrompt: 'You are a test assistant.',
      maxTokens: 100,
      budgetLimits: {
        maxStepsPerTurn: 2,
        maxTokensPerTurn: 10000,
        maxTurnDurationMs: 60000,
      },
      contextWindow: 100000,
    });

    const task = await taskStore.create({
      description: 'Long running task',
      cwd: dir,
      model: 'anthropic/test-model',
    });

    const result = await runner.run({
      taskId: task.id,
      prompt: 'Do something that takes many steps',
      cwd: dir,
      model: 'anthropic/test-model',
    });

    expect(result.endReason).toBe('max_steps');

    const updatedTask = await taskStore.get(task.id);
    expect(updatedTask?.status).toBe('cancelled');
    expect(updatedTask?.endReason).toBe('budget');
  });
});
