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

  it('无记忆时 buildInjection 返回 undefined', async () => {
    const injection = await injector.buildInjection({ userInput: 'anything' });
    expect(injection).toBeUndefined();
  });

  it('maxItems 截断注入条数', async () => {
    for (let i = 0; i < 5; i += 1) {
      await store.create({
        title: 'Item ' + i,
        content: 'Content ' + i,
        category: 'general',
        description: 'Desc ' + i,
        keywords: ['k' + i],
        status: 'active',
      });
    }
    const capped = new MemoryInjector(store, { maxItems: 2 });
    const injection = await capped.buildInjection({ userInput: '' });
    expect(injection?.count).toBe(2);
    expect(injection?.memoryIds).toHaveLength(2);
  });

  it('maxTokens 截断但至少保留一条', async () => {
    await store.create({
      title: 'Big',
      content: 'x'.repeat(4000),
      category: 'general',
      description: 'big',
      keywords: ['big'],
      status: 'active',
    });
    const capped = new MemoryInjector(store, { maxTokens: 1 });
    const injection = await capped.buildInjection({ userInput: '' });
    expect(injection?.count).toBe(1);
    expect(injection?.text).toContain('Big');
  });

  it('relevant 模式按用户输入检索命中', async () => {
    await store.create({
      title: 'TypeScript strict',
      content: 'User prefers strict TypeScript',
      category: 'preference',
      description: 'TS strict mode',
      keywords: ['typescript'],
      status: 'active',
    });
    await store.create({
      title: 'Unrelated',
      content: 'Something about cooking',
      category: 'general',
      description: 'cooking',
      keywords: ['cooking'],
      status: 'active',
    });

    const relevant = new MemoryInjector(store, { mode: 'relevant' });
    const injection = await relevant.buildInjection({ userInput: 'typescript' });
    expect(injection?.count).toBe(1);
    expect(injection?.text).toContain('TypeScript strict');
    expect(injection?.text).not.toContain('Unrelated');
  });
});
