import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteDatabase } from '../../src/storage/db.js';
import { openDatabase } from '../../src/storage/db.js';
import { SqliteMemoryStore } from '../../src/storage/memory-store.js';
import type { MemoryCategory } from '../../src/types/memory.js';

let dir: string;
let db: SqliteDatabase;
let store: SqliteMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-memory-'));
  db = openDatabase(join(dir, 'test.db'));
  store = new SqliteMemoryStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const baseInput = {
  title: 'TypeScript strict mode',
  content: 'User prefers TypeScript strict mode in all projects',
  category: 'preference' as MemoryCategory,
  description: 'User likes strict TypeScript',
  keywords: ['typescript', 'strict'],
  status: 'active' as const,
};

describe('SqliteMemoryStore', () => {
  it('create → get 一致', async () => {
    const created = await store.create(baseInput);

    expect(created.id).toBeTruthy();
    expect(created.status).toBe('active');
    expect(created.createdAt).toBeTruthy();

    const fetched = await store.get(created.id);
    expect(fetched).toEqual(created);
  });

  it('create 带 sourceSessionId 可回读', async () => {
    const created = await store.create({ ...baseInput, sourceSessionId: 'sess-123' });
    const fetched = await store.get(created.id);
    expect(fetched?.sourceSessionId).toBe('sess-123');
  });

  it('listActive 只返回 active 状态', async () => {
    await store.create(baseInput);
    await store.create({ ...baseInput, title: 'Another active' });
    const archived = await store.create({ ...baseInput, title: 'Archived one' });
    await store.archive(archived.id);

    const active = await store.listActive();
    expect(active).toHaveLength(2);
    expect(active.every((m) => m.status === 'active')).toBe(true);
    expect(active.some((m) => m.title === 'Archived one')).toBe(false);
  });

  it('archive 后 listActive 不包含', async () => {
    const m = await store.create(baseInput);
    await store.archive(m.id);

    const active = await store.listActive();
    expect(active).toHaveLength(0);

    const fetched = await store.get(m.id);
    expect(fetched?.status).toBe('archived');
  });

  it('update 修改字段并刷新 updatedAt', async () => {
    const m = await store.create(baseInput);
    const updated = await store.update(m.id, { title: 'Updated title', keywords: ['new'] });

    expect(updated?.title).toBe('Updated title');
    expect(updated?.keywords).toEqual(['new']);
    expect(updated?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('update 不存在的 id 返回 undefined', async () => {
    const result = await store.update('nonexistent', { title: 'nope' });
    expect(result).toBeUndefined();
  });

  it('search 命中正确结果（FTS5 MATCH）', async () => {
    await store.create(baseInput);
    await store.create({
      title: 'Python environment',
      content: 'Uses Python 3.12 with uv package manager',
      category: 'environment',
      description: 'Python development setup',
      keywords: ['python', 'uv'],
      status: 'active',
    });

    const results = await store.search('typescript');
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('TypeScript strict mode');
  });

  it('search 多关键词 OR 匹配', async () => {
    await store.create(baseInput);
    await store.create({
      title: 'Python environment',
      content: 'Uses Python 3.12',
      category: 'environment',
      description: 'Python setup',
      keywords: ['python'],
      status: 'active',
    });

    const results = await store.search('typescript python');
    expect(results).toHaveLength(2);
  });

  it('search 空查询返回全部 active', async () => {
    await store.create(baseInput);
    await store.create({ ...baseInput, title: 'Second' });
    const archived = await store.create({ ...baseInput, title: 'Archived' });
    await store.archive(archived.id);

    const results = await store.search('');
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.status === 'active')).toBe(true);
  });

  it('search 支持 category 过滤', async () => {
    await store.create(baseInput);
    await store.create({
      title: 'Python env',
      content: 'Python 3.12',
      category: 'environment',
      description: 'python environment',
      keywords: ['python'],
      status: 'active',
    });

    const results = await store.search('python', { category: 'environment' });
    expect(results).toHaveLength(1);
    expect(results[0]?.category).toBe('environment');
  });

  it('delete 后 FTS 也清除（触发器生效）', async () => {
    const m = await store.create(baseInput);

    // 先确认搜索能命中
    let results = await store.search('typescript');
    expect(results).toHaveLength(1);

    // 直接 SQL 删除（模拟触发器场景）
    db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);

    results = await store.search('typescript');
    expect(results).toHaveLength(0);
  });

  it('get 不存在的 id 返回 undefined', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeUndefined();
  });
});
