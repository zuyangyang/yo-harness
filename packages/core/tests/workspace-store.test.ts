import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SqliteDatabase } from '../src/storage/db.js';
import { openDatabase } from '../src/storage/db.js';
import { SqliteSessionStore } from '../src/storage/session-store.js';
import { SqliteWorkspaceStore } from '../src/storage/workspace-store.js';

let dir: string;
let db: SqliteDatabase;
let workspaces: SqliteWorkspaceStore;
let sessions: SqliteSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-workspaces-'));
  db = openDatabase(join(dir, 'test.db'));
  workspaces = new SqliteWorkspaceStore(db);
  sessions = new SqliteSessionStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteWorkspaceStore', () => {
  it('create/get 往返一致，默认 description 空、color/icon 为 null', async () => {
    const ws = await workspaces.create({ name: '工作' });
    const loaded = await workspaces.get(ws.id);

    expect(loaded?.name).toBe('工作');
    expect(loaded?.description).toBe('');
    expect(loaded?.color).toBeNull();
    expect(loaded?.icon).toBeNull();
    expect(loaded?.sortOrder).toBe(0);
  });

  it('get 未知 id 返回 undefined', async () => {
    expect(await workspaces.get('no-such-id')).toBeUndefined();
  });

  it('update 可重命名并改颜色', async () => {
    const ws = await workspaces.create({ name: 'a' });
    const updated = await workspaces.update(ws.id, { name: 'b', color: '#4f8cff' });
    expect(updated?.name).toBe('b');
    expect(updated?.color).toBe('#4f8cff');
  });

  it('update 未知 id 返回 undefined', async () => {
    expect(await workspaces.update('nope', { name: 'x' })).toBeUndefined();
  });

  it('delete 删除工作区', async () => {
    const ws = await workspaces.create({ name: 'a' });
    await workspaces.delete(ws.id);
    expect(await workspaces.get(ws.id)).toBeUndefined();
  });

  it('delete 工作区后其下会话解绑为独立会话', async () => {
    const ws = await workspaces.create({ name: 'a' });
    const session = await sessions.create({ model: 'm', cwd: '/w', workspaceId: ws.id });

    await workspaces.delete(ws.id);

    expect((await sessions.get(session.id))?.workspaceId).toBeNull();
  });

  it('list 返回工作区及 active 会话数', async () => {
    const ws = await workspaces.create({ name: 'a' });
    await sessions.create({ model: 'm', cwd: '/w', workspaceId: ws.id });
    await sessions.create({ model: 'm', cwd: '/w', workspaceId: ws.id });
    await sessions.create({ model: 'm', cwd: '/w' }); // 独立会话不计入

    const list = await workspaces.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.sessionCount).toBe(2);
  });
});
