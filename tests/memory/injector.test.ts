import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/storage/db.js';
import { SqliteMemoryStore } from '../../src/storage/memory-store.js';
import { MemoryInjector } from '../../src/memory/injector.js';
import type { SqliteDatabase } from '../../src/storage/db.js';

let dir: string;
let db: SqliteDatabase;
let store: SqliteMemoryStore;
let injector: MemoryInjector;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-injector-'));
  db = openDatabase(join(dir, 'test.db'));
  store = new SqliteMemoryStore(db);
  injector = new MemoryInjector(store);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryInjector', () => {
  it('无记忆 → 返回空字符串', async () => {
    const result = await injector.inject();
    expect(result).toBe('');
  });

  it('多条记忆按类别分组、格式正确', async () => {
    await store.create({
      title: 'TypeScript strict',
      content: 'User prefers strict TypeScript',
      category: 'preference',
      description: 'TS strict mode',
      keywords: ['typescript'],
      status: 'active',
    });
    await store.create({
      title: 'Node 20',
      content: 'Project uses Node.js 20',
      category: 'environment',
      description: 'Node.js version',
      keywords: ['node'],
      status: 'active',
    });
    await store.create({
      title: 'Hexagonal architecture',
      content: 'Project uses hexagonal architecture',
      category: 'project_knowledge',
      description: 'Architecture style',
      keywords: ['architecture'],
      status: 'active',
    });

    const result = await injector.inject();

    expect(result).toContain('<semantic-memory>');
    expect(result).toContain('</semantic-memory>');
    expect(result).toContain('User Preferences');
    expect(result).toContain('TypeScript strict');
    expect(result).toContain('Environment Facts');
    expect(result).toContain('Node 20');
    expect(result).toContain('Project Knowledge');
    expect(result).toContain('Hexagonal architecture');
  });

  it('archived 记忆不注入', async () => {
    const m = await store.create({
      title: 'Archived memory',
      content: 'Should not appear',
      category: 'general',
      description: 'Archived',
      keywords: ['archived'],
      status: 'active',
    });
    await store.archive(m.id);

    const result = await injector.inject();
    expect(result).toBe('');
  });

  it('同类别记忆归入同一分组', async () => {
    await store.create({
      title: 'Pref 1',
      content: 'Content 1',
      category: 'preference',
      description: 'Desc 1',
      keywords: ['a'],
      status: 'active',
    });
    await store.create({
      title: 'Pref 2',
      content: 'Content 2',
      category: 'preference',
      description: 'Desc 2',
      keywords: ['b'],
      status: 'active',
    });

    const result = await injector.inject();

    // User Preferences 标题只出现一次
    const matches = result.match(/User Preferences/g);
    expect(matches).toHaveLength(1);
    expect(result).toContain('Pref 1');
    expect(result).toContain('Pref 2');
  });
});
