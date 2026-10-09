import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/storage/db.js';

describe('schema v8（定时任务）', () => {
  it('全新库迁移到 v8：创建 model_providers / model_settings / scheduled_tasks / notifications，sessions 加 permission_mode，tasks 加 schedule_id/trigger', () => {
    const db = openDatabase(':memory:');

    const version = (
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
    ).value;
    expect(version).toBe('8');

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
});
