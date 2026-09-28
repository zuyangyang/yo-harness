/**
 * StorageBackend 契约测试：同一组用例跑 SQLite 实现。
 *
 * PostgreSQL 实现需要真实数据库连接，通过环境变量 PG_TEST_URL 控制：
 * - 未设置时只跑 SQLite 测试
 * - 设置后同时跑 PostgreSQL 测试（CI 环境用 testcontainers 或 docker-compose）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { StorageBackend } from '../../src/storage/interface.js';
import { createSqliteBackend } from '../../src/storage/sqlite.js';
import type { AgentEvent } from '@yo-harness/core/types/events.js';
import type { CheckpointFileInfo } from '@yo-harness/core/core/ports.js';

interface BackendFactory {
  name: string;
  create(): Promise<StorageBackend>;
  destroy(backend: StorageBackend): Promise<void>;
}

const sqliteFactory: BackendFactory = {
  name: 'SQLite',
  async create() {
    return createSqliteBackend(':memory:');
  },
  async destroy(backend) {
    await backend.close();
  },
};

function runContractTests(factory: BackendFactory) {
  let backend: StorageBackend;

  beforeEach(async () => {
    backend = await factory.create();
    await backend.initialize();
  });

  afterEach(async () => {
    await factory.destroy(backend);
  });

  describe('SessionStore', () => {
    it('create → get → listRecent', async () => {
      const session = await backend.sessions.create({
        model: 'anthropic/claude-sonnet-4-20250514',
        cwd: '/tmp/test',
        title: 'test session',
      });

      expect(session.id).toBeDefined();
      expect(session.title).toBe('test session');
      expect(session.status).toBe('active');
      expect(session.type).toBe('interactive');

      const fetched = await backend.sessions.get(session.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('test session');

      const recent = await backend.sessions.listRecent(10);
      expect(recent).toHaveLength(1);
      expect(recent[0]!.id).toBe(session.id);
    });

    it('touch updates updatedAt', async () => {
      const session = await backend.sessions.create({ model: 'm', cwd: '/tmp' });
      const before = (await backend.sessions.get(session.id))!.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      await backend.sessions.touch(session.id);

      const after = (await backend.sessions.get(session.id))!.updatedAt;
      expect(after).not.toBe(before);
    });

    it('updateTitle', async () => {
      const session = await backend.sessions.create({ model: 'm', cwd: '/tmp' });
      await backend.sessions.updateTitle(session.id, 'new title');
      const updated = await backend.sessions.get(session.id);
      expect(updated!.title).toBe('new title');
    });

    it('get returns undefined for non-existent id', async () => {
      const result = await backend.sessions.get('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('EventStore', () => {
    it('append → replay → lastSeq', async () => {
      const session = await backend.sessions.create({ model: 'm', cwd: '/tmp' });

      const event1: AgentEvent = { type: 'user_input', content: 'hello' };
      const event2: AgentEvent = { type: 'user_input', content: 'world' };

      const env1 = await backend.events.append(session.id, event1);
      const env2 = await backend.events.append(session.id, event2);

      expect(env1.seq).toBe(1);
      expect(env2.seq).toBe(2);
      expect(env1.payload.type).toBe('user_input');

      const replayed = await backend.events.replay(session.id);
      expect(replayed).toHaveLength(2);
      expect(replayed[0]!.seq).toBe(1);
      expect(replayed[1]!.seq).toBe(2);

      const last = await backend.events.lastSeq(session.id);
      expect(last).toBe(2);
    });

    it('lastSeq returns 0 for empty session', async () => {
      const session = await backend.sessions.create({ model: 'm', cwd: '/tmp' });
      const last = await backend.events.lastSeq(session.id);
      expect(last).toBe(0);
    });
  });

  describe('CheckpointStore', () => {
    it('create → get → listBySession', async () => {
      const session = await backend.sessions.create({ model: 'm', cwd: '/tmp' });

      const files: CheckpointFileInfo[] = [
        { relPath: 'src/a.ts', content: Buffer.from('console.log("a")') },
        { relPath: 'src/b.ts', content: null },
      ];

      const cpId = await backend.checkpoints.create({
        sessionId: session.id,
        seq: 1,
        source: 'manual',
        files,
      });

      expect(cpId).toBeDefined();

      const detail = await backend.checkpoints.get(cpId);
      expect(detail).toBeDefined();
      expect(detail!.source).toBe('manual');
      expect(detail!.files).toHaveLength(2);
      expect(detail!.files[0]!.relPath).toBe('src/a.ts');
      expect(detail!.files[0]!.hasContent).toBe(true);
      expect(detail!.files[1]!.relPath).toBe('src/b.ts');
      expect(detail!.files[1]!.hasContent).toBe(false);

      const list = await backend.checkpoints.listBySession(session.id);
      expect(list).toHaveLength(1);
      expect(list[0]!.fileCount).toBe(2);
    });

    it('readFileContent returns buffer or null', async () => {
      const session = await backend.sessions.create({ model: 'm', cwd: '/tmp' });
      const content = Buffer.from('hello world');

      const cpId = await backend.checkpoints.create({
        sessionId: session.id,
        seq: 1,
        source: 'manual',
        files: [{ relPath: 'test.txt', content }],
      });

      const read = await backend.checkpoints.readFileContent(cpId, 'test.txt');
      expect(read).toEqual(content);

      const missing = await backend.checkpoints.readFileContent(cpId, 'nope.txt');
      expect(missing).toBeNull();
    });

    it('getAdjacent finds prev/next checkpoints', async () => {
      const session = await backend.sessions.create({ model: 'm', cwd: '/tmp' });

      const cp1 = await backend.checkpoints.create({
        sessionId: session.id, seq: 1, source: 'manual', files: [],
      });
      const cp2 = await backend.checkpoints.create({
        sessionId: session.id, seq: 5, source: 'manual', files: [],
      });
      const cp3 = await backend.checkpoints.create({
        sessionId: session.id, seq: 10, source: 'manual', files: [],
      });

      const prev = await backend.checkpoints.getAdjacent(session.id, 5, 'prev');
      expect(prev).toBeDefined();
      expect(prev!.id).toBe(cp1);
      expect(prev!.seq).toBe(1);

      const next = await backend.checkpoints.getAdjacent(session.id, 5, 'next');
      expect(next).toBeDefined();
      expect(next!.id).toBe(cp3);
      expect(next!.seq).toBe(10);
    });
  });

  describe('MemoryStore', () => {
    it('create → get → listActive', async () => {
      const memory = await backend.memories.create({
        title: 'test memory',
        content: 'some content',
        category: 'general',
        description: 'a test',
        keywords: ['test'],
        status: 'active',
      });

      expect(memory.id).toBeDefined();
      expect(memory.title).toBe('test memory');

      const fetched = await backend.memories.get(memory.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('test memory');
      expect(fetched!.keywords).toEqual(['test']);

      const active = await backend.memories.listActive();
      expect(active).toHaveLength(1);
    });

    it('update merges fields', async () => {
      const memory = await backend.memories.create({
        title: 'original',
        content: 'content',
        category: 'general',
        description: 'desc',
        keywords: [],
        status: 'active',
      });

      const updated = await backend.memories.update(memory.id, { title: 'updated' });
      expect(updated).toBeDefined();
      expect(updated!.title).toBe('updated');
      expect(updated!.content).toBe('content');
    });

    it('archive changes status', async () => {
      const memory = await backend.memories.create({
        title: 't', content: 'c', category: 'general',
        description: 'd', keywords: [], status: 'active',
      });

      await backend.memories.archive(memory.id);
      const active = await backend.memories.listActive();
      expect(active).toHaveLength(0);

      const archived = await backend.memories.get(memory.id);
      expect(archived!.status).toBe('archived');
    });

    it('search finds by content', async () => {
      await backend.memories.create({
        title: 'TypeScript tips',
        content: 'use strict mode for better type safety',
        category: 'general',
        description: 'ts tips',
        keywords: ['typescript'],
        status: 'active',
      });
      await backend.memories.create({
        title: 'Python notes',
        content: 'virtual environments are important',
        category: 'general',
        description: 'py notes',
        keywords: ['python'],
        status: 'active',
      });

      const results = await backend.memories.search('typescript');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((m) => m.title === 'TypeScript tips')).toBe(true);
    });
  });

  describe('TaskStore', () => {
    it('create → get → list', async () => {
      const task = await backend.tasks.create({
        description: 'run tests',
        cwd: '/tmp',
        model: 'anthropic/claude-sonnet-4-20250514',
      });

      expect(task.id).toBeDefined();
      expect(task.status).toBe('pending');
      expect(task.sessionId).toBeDefined();

      const fetched = await backend.tasks.get(task.id);
      expect(fetched).toBeDefined();
      expect(fetched!.description).toBe('run tests');

      const list = await backend.tasks.list();
      expect(list).toHaveLength(1);
    });

    it('updateStatus transitions state', async () => {
      const task = await backend.tasks.create({
        description: 'task', cwd: '/tmp', model: 'm',
      });

      await backend.tasks.updateStatus(task.id, 'running');
      let fetched = await backend.tasks.get(task.id);
      expect(fetched!.status).toBe('running');

      await backend.tasks.updateStatus(task.id, 'completed', 'end_turn', undefined, 'done');
      fetched = await backend.tasks.get(task.id);
      expect(fetched!.status).toBe('completed');
      expect(fetched!.endReason).toBe('end_turn');
      expect(fetched!.summary).toBe('done');
      expect(fetched!.completedAt).toBeDefined();
    });
  });
}

describe('StorageBackend contract — SQLite', () => {
  runContractTests(sqliteFactory);
});
