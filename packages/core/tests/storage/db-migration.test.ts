import { describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/storage/db.js';

describe('schema v6（模型配置表）', () => {
  it('全新库迁移到 v6 并创建 model_providers / model_settings', () => {
    const db = openDatabase(':memory:');

    const version = (
      db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
    ).value;
    expect(version).toBe('6');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toContain('model_providers');
    expect(tables).toContain('model_settings');

    db.close();
  });
});
