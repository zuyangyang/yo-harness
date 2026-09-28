import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/db.js';
import { SqliteCheckpointStore } from '../../src/storage/checkpoint-store.js';

/** 用内存 SQLite 创建测试数据库（含 v2 schema） */
function createTestDb() {
  return openDatabase(':memory:');
}

/** 手动建一个 session 记录（检查点引用 session_id） */
function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    'INSERT INTO sessions (id, title, model, cwd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'test', 'fake', '/tmp', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

describe('SqliteCheckpointStore', () => {
  let db: Database.Database;
  let store: SqliteCheckpointStore;
  const sessionId = 'sess-1';

  beforeEach(() => {
    db = createTestDb();
    insertSession(db, sessionId);
    store = new SqliteCheckpointStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('创建检查点并读回文件内容', async () => {
    const cpId = await store.create({
      sessionId,
      seq: 1,
      source: 'auto_write',
      files: [{ relPath: 'src/a.ts', content: Buffer.from('original content') }],
    });

    const detail = await store.get(cpId);
    expect(detail).toBeDefined();
    expect(detail!.source).toBe('auto_write');
    expect(detail!.files).toEqual([{ relPath: 'src/a.ts', hasContent: true }]);

    const content = await store.readFileContent(cpId, 'src/a.ts');
    expect(content).toBeInstanceOf(Buffer);
    expect(content!.toString('utf8')).toBe('original content');
  });

  it('新建文件快照 content=null', async () => {
    const cpId = await store.create({
      sessionId,
      seq: 1,
      source: 'auto_write',
      files: [{ relPath: 'new-file.ts', content: null }],
    });

    const detail = await store.get(cpId);
    expect(detail!.files).toEqual([{ relPath: 'new-file.ts', hasContent: false }]);

    const content = await store.readFileContent(cpId, 'new-file.ts');
    expect(content).toBeNull();
  });

  it('listBySession 按 seq 升序返回', async () => {
    await store.create({
      sessionId,
      seq: 5,
      source: 'auto_write',
      files: [{ relPath: 'b.ts', content: Buffer.from('b') }],
    });
    await store.create({
      sessionId,
      seq: 1,
      source: 'auto_write',
      files: [{ relPath: 'a.ts', content: Buffer.from('a') }],
    });
    await store.create({
      sessionId,
      seq: 3,
      source: 'manual',
      files: [{ relPath: 'c.ts', content: Buffer.from('c') }],
    });

    const list = await store.listBySession(sessionId);
    expect(list).toHaveLength(3);
    expect(list.map((c) => c.seq)).toEqual([1, 3, 5]);
    expect(list[0]!.source).toBe('auto_write');
    expect(list[1]!.source).toBe('manual');
    expect(list[2]!.fileCount).toBe(1);
  });

  it('getAdjacent 正确返回前/后检查点', async () => {
    await store.create({
      sessionId,
      seq: 2,
      source: 'auto_write',
      files: [],
    });
    await store.create({
      sessionId,
      seq: 5,
      source: 'auto_write',
      files: [],
    });
    await store.create({
      sessionId,
      seq: 8,
      source: 'auto_write',
      files: [],
    });

    // seq=5 的前一个 → seq=2
    const prev = await store.getAdjacent(sessionId, 5, 'prev');
    expect(prev).toEqual(expect.objectContaining({ seq: 2 }));

    // seq=5 的后一个 → seq=8
    const next = await store.getAdjacent(sessionId, 5, 'next');
    expect(next).toEqual(expect.objectContaining({ seq: 8 }));

    // seq=2 没有前一个
    const noPrev = await store.getAdjacent(sessionId, 2, 'prev');
    expect(noPrev).toBeUndefined();

    // seq=8 没有后一个
    const noNext = await store.getAdjacent(sessionId, 8, 'next');
    expect(noNext).toBeUndefined();
  });

  it('get 不存在的检查点返回 undefined', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('readFileContent 不存在的路径返回 null', async () => {
    const cpId = await store.create({
      sessionId,
      seq: 1,
      source: 'auto_write',
      files: [{ relPath: 'a.ts', content: Buffer.from('x') }],
    });
    const content = await store.readFileContent(cpId, 'nonexistent.ts');
    expect(content).toBeNull();
  });
});
