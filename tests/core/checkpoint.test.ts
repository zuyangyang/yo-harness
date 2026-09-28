import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { openDatabase } from '../../src/storage/db.js';
import { SqliteCheckpointStore } from '../../src/storage/checkpoint-store.js';
import { CheckpointManager } from '../../src/core/checkpoint.js';

/** 每次测试用独立临时目录，避免文件系统副作用互相干扰 */
function createTempDir(): string {
  const dir = join(tmpdir(), `checkpoint-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(
    'INSERT INTO sessions (id, title, model, cwd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'test', 'fake', '/tmp', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

describe('CheckpointManager', () => {
  let db: Database.Database;
  let store: SqliteCheckpointStore;
  let mgr: CheckpointManager;
  let cwd: string;
  const sessionId = 'sess-checkpoint';

  beforeEach(() => {
    db = openDatabase(':memory:');
    insertSession(db, sessionId);
    store = new SqliteCheckpointStore(db);
    mgr = new CheckpointManager(store, sessionId);
    cwd = createTempDir();
  });

  afterEach(() => {
    db.close();
  });

  it('snapshotBeforeWrite：已有文件 → 快照原始内容', async () => {
    const relPath = 'src/a.ts';
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, relPath), 'original');

    const cpId = await mgr.snapshotBeforeWrite(cwd, relPath, 1);
    expect(cpId).toBeTruthy();

    // 检查点里的内容应该是快照时的原始内容
    const content = await store.readFileContent(cpId, relPath);
    expect(content).toBeInstanceOf(Buffer);
    expect(content!.toString('utf8')).toBe('original');
  });

  it('snapshotBeforeWrite：不存在的文件 → content=null', async () => {
    const cpId = await mgr.snapshotBeforeWrite(cwd, 'new-file.ts', 1);
    const content = await store.readFileContent(cpId, 'new-file.ts');
    expect(content).toBeNull();
  });

  it('undo：修改文件 → 恢复原内容', async () => {
    const relPath = 'src/b.ts';
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, relPath), 'before-edit');

    // seq=1 时快照
    await mgr.snapshotBeforeWrite(cwd, relPath, 1);

    // 模拟 write_file 修改了文件
    writeFileSync(join(cwd, relPath), 'after-edit');
    expect(readFileSync(join(cwd, relPath), 'utf8')).toBe('after-edit');

    // undo 到 seq=1 之前的状态
    const result = await mgr.undo(cwd, 2);
    expect(result.success).toBe(true);
    expect(result.files).toEqual([relPath]);

    // 文件内容应恢复
    expect(readFileSync(join(cwd, relPath), 'utf8')).toBe('before-edit');
  });

  it('undo：新建文件 → 删除', async () => {
    const relPath = 'brand-new.ts';
    const absPath = join(cwd, relPath);

    // seq=1 时快照一个不存在的文件
    await mgr.snapshotBeforeWrite(cwd, relPath, 1);

    // 模拟 write_file 创建了文件
    writeFileSync(absPath, 'new content');
    expect(existsSync(absPath)).toBe(true);

    // undo
    const result = await mgr.undo(cwd, 2);
    expect(result.success).toBe(true);
    expect(existsSync(absPath)).toBe(false);
  });

  it('undo：无检查点时返回 success=false', async () => {
    const result = await mgr.undo(cwd, 1);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('no checkpoint to undo');
  });
});
