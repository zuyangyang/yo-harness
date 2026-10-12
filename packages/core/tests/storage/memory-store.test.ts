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

describe('SqliteMemoryStore v9 智能记忆元数据', () => {
  it('create 补默认值：importance 5 / durability durable / confidence 1 / pinned false / accessCount 0', async () => {
    const m = await store.create(baseInput);
    expect(m.importance).toBe(5);
    expect(m.durability).toBe('durable');
    expect(m.confidence).toBe(1);
    expect(m.pinned).toBe(false);
    expect(m.accessCount).toBe(0);
    expect(m.key).toBeUndefined();
    expect(m.expiresAt).toBeUndefined();
  });

  it('create → get 往返保留全部新字段', async () => {
    const created = await store.create({
      ...baseInput,
      key: 'profile.name',
      importance: 9,
      confidence: 0.8,
      pinned: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2029-01-01T00:00:00.000Z',
      supersededBy: 'other-id',
      lastAccessedAt: '2026-01-02T00:00:00.000Z',
    });

    const got = await store.get(created.id);
    expect(got?.key).toBe('profile.name');
    expect(got?.importance).toBe(9);
    expect(got?.confidence).toBe(0.8);
    expect(got?.pinned).toBe(true);
    expect(got?.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(got?.validFrom).toBe('2026-01-01T00:00:00.000Z');
    expect(got?.validTo).toBe('2029-01-01T00:00:00.000Z');
    expect(got?.supersededBy).toBe('other-id');
    expect(got?.lastAccessedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('key 唯一：同一槽位第二次写入被拒绝', async () => {
    await store.create({ ...baseInput, key: 'profile.name', content: 'first' });
    await expect(
      store.create({ ...baseInput, key: 'profile.name', content: 'second' }),
    ).rejects.toThrow();

    const all = await store.listActive();
    expect(all).toHaveLength(1);
    expect(all[0]?.content).toBe('first');
  });

  it('update 可改写 v9 字段（含 superseded 状态）', async () => {
    const created = await store.create({ ...baseInput, importance: 3 });
    const updated = await store.update(created.id, {
      importance: 8,
      expiresAt: '2031-01-01T00:00:00.000Z',
      supersededBy: 'newer',
      status: 'superseded',
    });

    expect(updated?.importance).toBe(8);
    expect(updated?.expiresAt).toBe('2031-01-01T00:00:00.000Z');
    expect(updated?.supersededBy).toBe('newer');
    expect(updated?.status).toBe('superseded');
  });
});

describe('SqliteMemoryStore 过期语义（隐藏不删除）', () => {
  it('过期记忆不进 listActive / search，但 get 仍可取回', async () => {
    const expired = await store.create({
      ...baseInput,
      title: 'old fact',
      keywords: ['obsolete'],
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const future = await store.create({
      ...baseInput,
      title: 'future fact',
      keywords: ['obsolete'],
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const permanent = await store.create({
      ...baseInput,
      title: 'permanent fact',
      keywords: ['obsolete'],
    });

    const active = await store.listActive();
    expect(active.map((m) => m.id).sort()).toEqual([future.id, permanent.id].sort());

    const hits = await store.search('obsolete');
    expect(hits.map((m) => m.id).sort()).toEqual([future.id, permanent.id].sort());

    // 隐藏不是删除：仍可按 id 取回
    expect((await store.get(expired.id))?.title).toBe('old fact');
  });

  it('pinned 记忆免疫过期', async () => {
    const pinned = await store.create({
      ...baseInput,
      title: 'pinned',
      pinned: true,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const active = await store.listActive();
    expect(active.map((m) => m.id)).toEqual([pinned.id]);
  });

  it('清空 expires_at 即恢复可见（可逆）', async () => {
    const m = await store.create({ ...baseInput, expiresAt: '2000-01-01T00:00:00.000Z' });
    expect(await store.listActive()).toHaveLength(0);

    await store.update(m.id, { expiresAt: null });
    expect(await store.listActive()).toHaveLength(1);
  });

  it('search 空查询走 listByFilter 也过滤过期', async () => {
    await store.create({ ...baseInput, expiresAt: '2000-01-01T00:00:00.000Z' });
    await store.create({ ...baseInput, title: 'kept' });
    const rows = await store.search('   ');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('kept');
  });
});

describe('SqliteMemoryStore key 确定性 upsert', () => {
  it('首次创建 → 再次更新同一行，不产生重复', async () => {
    const first = await store.upsertByKey({
      ...baseInput,
      key: 'profile.name',
      title: 'User name',
      content: 'The user is called yang',
      importance: 9,
    });
    expect(first.created).toBe(true);

    const second = await store.upsertByKey({
      ...baseInput,
      key: 'profile.name',
      title: 'User name',
      content: 'The user is called Yang Yang',
      importance: 9,
    });
    expect(second.created).toBe(false);
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.content).toBe('The user is called Yang Yang');
    expect(await store.listActive()).toHaveLength(1);
  });

  it('同一槽位的事实被取代后，新值复位为 active 并清空取代指针', async () => {
    const first = await store.upsertByKey({ ...baseInput, key: 'preference.language' });
    await store.update(first.memory.id, {
      status: 'superseded',
      supersededBy: 'other',
      validTo: '2026-01-01T00:00:00.000Z',
    });

    const second = await store.upsertByKey({
      ...baseInput,
      key: 'preference.language',
      content: 'now English',
    });
    expect(second.created).toBe(false);
    expect(second.memory.status).toBe('active');
    expect(second.memory.supersededBy).toBeUndefined();
    expect(second.memory.validTo).toBeUndefined();
    expect(second.memory.content).toBe('now English');
  });

  it('keyed upsert 会用新 TTL 整体替换旧 TTL（未提供即永久）', async () => {
    await store.upsertByKey({
      ...baseInput,
      key: 'env.db',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    // 过期后不可见，但 key 仍在
    expect(await store.listActive()).toHaveLength(0);

    const next = await store.upsertByKey({ ...baseInput, key: 'env.db', content: 'now permanent' });
    expect(next.created).toBe(false);
    expect(next.memory.expiresAt).toBeUndefined();
    expect(await store.listActive()).toHaveLength(1);
  });

  it('getByKey 未命中返回 undefined', async () => {
    expect(await store.getByKey('nope')).toBeUndefined();
  });
});
