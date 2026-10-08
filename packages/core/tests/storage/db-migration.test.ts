import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/storage/db.js';

describe('schema v7（审批流 permission_mode）', () => {
  it('全新库迁移到 v7 并创建 model_providers / model_settings，sessions 加 permission_mode', () => {
    const db = openDatabase(':memory:');

    const version = (
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
    ).value;
    expect(version).toBe('7');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain('model_providers');
    expect(tables).toContain('model_settings');

    const sessionColumns = (
      db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(sessionColumns).toContain('permission_mode');

    db.close();
  });
});
