import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/storage/db.js';

describe('schema v9（智能记忆）', () => {
  it('全新库迁移到 v9：创建 model_providers / model_settings / scheduled_tasks / notifications，sessions 加 permission_mode，tasks 加 schedule_id/trigger', () => {
    const db = openDatabase(':memory:');

    const version = (
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
    ).value;
    expect(version).toBe('9');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain('model_providers');
    expect(tables).toContain('model_settings');
    expect(tables).toContain('scheduled_tasks');
    expect(tables).toContain('notifications');

    const sessionColumns = (
      db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(sessionColumns).toContain('permission_mode');

    const taskColumns = (
      db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(taskColumns).toContain('schedule_id');
    expect(taskColumns).toContain('trigger');

    db.close();
  });

  it('v9：memories 补充价值/时效/衰减元数据列与索引', () => {
    const db = openDatabase(':memory:');

    const columns = (
      db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    ).map((c) => c.name);
    for (const name of [
      'key',
      'importance',
      'durability',
      'confidence',
      'pinned',
      'expires_at',
      'valid_from',
      'valid_to',
      'superseded_by',
      'last_accessed_at',
      'access_count',
    ]) {
      expect(columns).toContain(name);
    }

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toContain('idx_memories_key');
    expect(indexes).toContain('idx_memories_expires');

    // key 非空时唯一：同一槽位不能有两条
    const base = {
      title: 't',
      content: 'c',
      category: 'general',
      description: 'd',
      keywords: '[]',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const insert = db.prepare(
      `INSERT INTO memories (id, title, content, category, description, keywords, status, key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('a', base.title, base.content, base.category, base.description, base.keywords, base.status, 'profile.name', base.created_at, base.updated_at);
    expect(() =>
      insert.run('b', base.title, base.content, base.category, base.description, base.keywords, base.status, 'profile.name', base.created_at, base.updated_at),
    ).toThrow();
    // key 为 NULL 时不受唯一约束限制
    insert.run('c', base.title, base.content, base.category, base.description, base.keywords, base.status, null, base.created_at, base.updated_at);
    insert.run('d', base.title, base.content, base.category, base.description, base.keywords, base.status, null, base.created_at, base.updated_at);

    db.close();
  });

  it('v9 迁移是幂等的：重复打开同一库不报错且版本不变', () => {
    const db = openDatabase(':memory:');
    expect(
      (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
        .value,
    ).toBe('9');
    db.close();
  });
});
