import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteDatabase } from '../src/storage/db.js';
import { openDatabase } from '../src/storage/db.js';
import { SqliteEventStore } from '../src/storage/event-store.js';
import { SqliteSessionStore } from '../src/storage/session-store.js';
import { SqliteWorkspaceStore } from '../src/storage/workspace-store.js';

let dir: string;
let db: SqliteDatabase;
let store: SqliteSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-sessions-'));
  db = openDatabase(join(dir, 'test.db'));
  store = new SqliteSessionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteSessionStore', () => {
  it('create/get 往返一致，默认状态为 active、title 为空串', async () => {
    const created = await store.create({ model: 'claude-x', cwd: '/tmp/w' });
    const loaded = await store.get(created.id);

    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe(created.id);
    expect(loaded?.model).toBe('claude-x');
    expect(loaded?.cwd).toBe('/tmp/w');
    expect(loaded?.status).toBe('active');
    expect(loaded?.title).toBe('');
  });

  it('带 title 的 create 在 get 时保留 title', async () => {
    const created = await store.create({ model: 'm', cwd: '/w', title: '调研任务' });
    expect((await store.get(created.id))?.title).toBe('调研任务');
  });

  it('get 未知 id 返回 undefined', async () => {
    expect(await store.get('no-such-id')).toBeUndefined();
  });

  it('listRecent 按 updated_at 倒序返回 active 会话', async () => {
    const a = await store.create({ model: 'm', cwd: '/w' });
    const b = await store.create({ model: 'm', cwd: '/w' });
    const c = await store.create({ model: 'm', cwd: '/w' });
    // listRecent 以 updated_at 排序，直接写库构造确定性的时间序
    const setUpdatedAt = (id: string, iso: string): void => {
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(iso, id);
    };
    setUpdatedAt(a.id, '2026-01-03T00:00:00.000Z');
    setUpdatedAt(b.id, '2026-01-05T00:00:00.000Z');
    setUpdatedAt(c.id, '2026-01-04T00:00:00.000Z');

    const recent = await store.listRecent(10);

    expect(recent.map((s) => s.id)).toEqual([b.id, c.id, a.id]);
  });

  it('listRecent 遵守 limit', async () => {
    await store.create({ model: 'm', cwd: '/w' });
    await store.create({ model: 'm', cwd: '/w' });
    await store.create({ model: 'm', cwd: '/w' });

    expect(await store.listRecent(2)).toHaveLength(2);
  });

  it('touch 刷新 updated_at', async () => {
    const created = await store.create({ model: 'm', cwd: '/w' });
    const stale = '2000-01-01T00:00:00.000Z';
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(stale, created.id);

    await store.touch(created.id);

    const updated = (await store.get(created.id))?.updatedAt;
    expect(updated).not.toBe(stale);
    expect(new Date(updated ?? '').getTime()).toBeGreaterThan(new Date(stale).getTime());
  });

  it('updateTitle 生效且可覆盖', async () => {
    const created = await store.create({ model: 'm', cwd: '/w', title: '旧标题' });
    await store.updateTitle(created.id, '新标题');
    expect((await store.get(created.id))?.title).toBe('新标题');
  });

  it('重新打开数据库后数据仍在', async () => {
    const created = await store.create({ model: 'm', cwd: '/w', title: '持久化' });
    const dbPath = join(dir, 'test.db');
    db.close();

    const reopened = openDatabase(dbPath);
    const reopenedStore = new SqliteSessionStore(reopened);
    expect((await reopenedStore.get(created.id))?.title).toBe('持久化');
    reopened.close();
  });

  it('默认 type 为 interactive', async () => {
    const created = await store.create({ model: 'm', cwd: '/w' });
    expect((await store.get(created.id))?.type).toBe('interactive');
  });

  it('可创建 background 类型的会话', async () => {
    const created = await store.create({ model: 'm', cwd: '/w', type: 'background' });
    expect((await store.get(created.id))?.type).toBe('background');
  });
});

describe('SqliteSessionStore workspace / pinned / delete', () => {
  it('create 默认 workspaceId=null、pinned=false、titleIsCustom=false', async () => {
    const created = await store.create({ model: 'm', cwd: '/w' });
    expect(created.workspaceId).toBeNull();
    expect(created.pinned).toBe(false);
    expect(created.titleIsCustom).toBe(false);
  });

  it('create 保留显式 workspaceId 与 titleIsCustom', async () => {
    const workspaces = new SqliteWorkspaceStore(db);
    const ws = await workspaces.create({ name: '工作' });
    const created = await store.create({ model: 'm', cwd: '/w', workspaceId: ws.id, titleIsCustom: true, title: '自命名' });
    expect(created.workspaceId).toBe(ws.id);
    expect(created.titleIsCustom).toBe(true);
  });

  it('list 支持 workspaceId 过滤与 workspaceId=none（独立会话）', async () => {
    const workspaces = new SqliteWorkspaceStore(db);
    const ws = await workspaces.create({ name: '工作' });
    const inWs = await store.create({ model: 'm', cwd: '/w', workspaceId: ws.id });
    const standalone = await store.create({ model: 'm', cwd: '/w' });

    const byWs = await store.list({ workspaceId: ws.id });
    expect(byWs.map((s) => s.id)).toEqual([inWs.id]);

    const none = await store.list({ workspaceId: 'none' });
    expect(none.map((s) => s.id)).toEqual([standalone.id]);
  });

  it('list 支持 status / query / pinned 过滤', async () => {
    const a = await store.create({ model: 'm', cwd: '/w', title: '重构认证模块' });
    await store.create({ model: 'm', cwd: '/w', title: '写周报' });
    await store.update(a.id, { status: 'archived' });

    const archived = await store.list({ status: 'archived' });
    expect(archived.map((s) => s.id)).toEqual([a.id]);

    const byQuery = await store.list({ query: '周报' });
    expect(byQuery.map((s) => s.title)).toEqual(['写周报']);

    await store.update(a.id, { status: 'active', pinned: true });
    const pinned = await store.list({ pinned: true });
    expect(pinned.map((s) => s.id)).toEqual([a.id]);
  });

  it('update 改名会置 titleIsCustom=true', async () => {
    const created = await store.create({ model: 'm', cwd: '/w' });
    const updated = await store.update(created.id, { title: '新名字', titleIsCustom: true });
    expect(updated?.title).toBe('新名字');
    expect(updated?.titleIsCustom).toBe(true);
  });

  it('update 移动工作区 / 解绑', async () => {
    const workspaces = new SqliteWorkspaceStore(db);
    const ws = await workspaces.create({ name: '工作' });
    const created = await store.create({ model: 'm', cwd: '/w' });

    await store.update(created.id, { workspaceId: ws.id });
    expect((await store.get(created.id))?.workspaceId).toBe(ws.id);

    await store.update(created.id, { workspaceId: null });
    expect((await store.get(created.id))?.workspaceId).toBeNull();
  });

  it('update 未知 id 返回 undefined', async () => {
    expect(await store.update('nope', { title: 'x' })).toBeUndefined();
  });

  it('delete 级联清理事件与会话自身', async () => {
    const events = new SqliteEventStore(db);
    const created = await store.create({ model: 'm', cwd: '/w' });
    await events.append(created.id, { type: 'user_input', content: 'hello' });

    await store.delete(created.id);

    expect(await store.get(created.id)).toBeUndefined();
    expect(await events.replay(created.id)).toHaveLength(0);
  });
});
