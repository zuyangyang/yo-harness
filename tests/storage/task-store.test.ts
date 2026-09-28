import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import type { SqliteDatabase } from '../../src/storage/db.js';
import { openDatabase } from '../../src/storage/db.js';
import { SqliteTaskStore } from '../../src/storage/task-store.js';

let dir: string;
let db: SqliteDatabase;
let taskStore: SqliteTaskStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-tasks-'));
  db = openDatabase(join(dir, 'test.db'));
  taskStore = new SqliteTaskStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteTaskStore', () => {
  it('create → get 一致', async () => {
    const task = await taskStore.create({
      description: 'List files in current directory',
      cwd: '/tmp/test',
      model: 'anthropic/claude-sonnet-4-5',
    });

    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.status).toBe('pending');
    expect(task.description).toBe('List files in current directory');
    expect(task.cwd).toBe('/tmp/test');
    expect(task.model).toBe('anthropic/claude-sonnet-4-5');

    const fetched = await taskStore.get(task.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(task.id);
    expect(fetched?.sessionId).toBe(task.sessionId);
    expect(fetched?.description).toBe(task.description);
    expect(fetched?.status).toBe('pending');
  });

  it('list 按 created_at 降序', async () => {
    const task1 = await taskStore.create({
      description: 'First task',
      cwd: '/tmp',
      model: 'test/model',
    });

    // 等待 1ms 确保时间戳不同
    await new Promise((resolve) => setTimeout(resolve, 2));

    const task2 = await taskStore.create({
      description: 'Second task',
      cwd: '/tmp',
      model: 'test/model',
    });

    const tasks = await taskStore.list();
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.id).toBe(task2.id);
    expect(tasks[1]?.id).toBe(task1.id);
  });

  it('updateStatus 正确更新', async () => {
    const task = await taskStore.create({
      description: 'Test task',
      cwd: '/tmp',
      model: 'test/model',
    });

    expect(task.status).toBe('pending');
    expect(task.endReason).toBeNull();
    expect(task.completedAt).toBeNull();

    await taskStore.updateStatus(task.id, 'running');
    const running = await taskStore.get(task.id);
    expect(running?.status).toBe('running');
    expect(running?.completedAt).toBeNull();

    await taskStore.updateStatus(task.id, 'completed', 'end_turn', undefined, 'Task completed successfully');
    const completed = await taskStore.get(task.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.endReason).toBe('end_turn');
    expect(completed?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(completed?.summary).toBe('Task completed successfully');
    expect(completed?.errorMessage).toBeNull();
  });

  it('updateStatus failed 记录 errorMessage', async () => {
    const task = await taskStore.create({
      description: 'Failing task',
      cwd: '/tmp',
      model: 'test/model',
    });

    await taskStore.updateStatus(task.id, 'failed', 'error', 'LLM API error: rate limit exceeded');
    const failed = await taskStore.get(task.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.endReason).toBe('error');
    expect(failed?.errorMessage).toBe('LLM API error: rate limit exceeded');
    expect(failed?.completedAt).not.toBeNull();
  });

  it('get 不存在的任务返回 undefined', async () => {
    const result = await taskStore.get('nonexistent-id');
    expect(result).toBeUndefined();
  });
});
