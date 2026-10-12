import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/types/common.js';
import type { AgentEvent, EventEnvelope } from '../../src/types/events.js';
import { FakeLLMClient } from '../../src/llm/providers/fake.js';
import { openDatabase } from '../../src/storage/db.js';
import { SqliteMemoryStore } from '../../src/storage/memory-store.js';
import { MemoryExtractor } from '../../src/memory/extractor.js';
import type { SqliteDatabase } from '../../src/storage/db.js';

const SILENT_LOGGER: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let dir: string;
let db: SqliteDatabase;
let store: SqliteMemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-extractor-'));
  db = openDatabase(join(dir, 'test.db'));
  store = new SqliteMemoryStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeEvents(sessionId: string, pairs: [string, string][]): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  let seq = 0;
  for (const [user, assistant] of pairs) {
    seq++;
    events.push({
      id: seq,
      sessionId,
      seq,
      ts: new Date().toISOString(),
      payload: { type: 'user_input', content: user } satisfies AgentEvent,
    });
    seq++;
    events.push({
      id: seq,
      sessionId,
      seq,
      ts: new Date().toISOString(),
      payload: { type: 'assistant_text', text: assistant, toolCalls: [] } satisfies AgentEvent,
    });
  }
  return events;
}

describe('MemoryExtractor', () => {
  it('fake provider 返回 JSON → 解析正确 → 存入 store', async () => {
    const json = JSON.stringify({
      memories: [
        {
          title: 'TypeScript strict mode',
          content: 'User prefers TypeScript strict mode',
          category: 'preference',
          description: 'Strict TypeScript preference',
          keywords: ['typescript', 'strict'],
        },
      ],
    });
    const fake = new FakeLLMClient([{ text: json, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['help me set up typescript with strict mode enabled please', 'sure, I will enable strict mode in your tsconfig.json file right away']]);
    const count = await extractor.extract(events, []);

    expect(count).toBe(1);
    expect(fake.consumed).toBe(1);

    const memories = await store.listActive();
    expect(memories).toHaveLength(1);
    expect(memories[0]?.title).toBe('TypeScript strict mode');
    expect(memories[0]?.category).toBe('preference');
    expect(memories[0]?.sourceSessionId).toBe('s1');
  });

  it('对话太短（< 100 字符）→ 不调 LLM → 返回 0', async () => {
    const fake = new FakeLLMClient([]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['hi', 'hello']]);
    const count = await extractor.extract(events, []);

    expect(count).toBe(0);
    expect(fake.consumed).toBe(0);
  });

  it('LLM 返回非法 JSON → 返回 0（不崩）', async () => {
    const fake = new FakeLLMClient([{ text: 'not valid json at all', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['help me set up the project with typescript and eslint configuration', 'sure, I will help you set up typescript with eslint']]);
    const count = await extractor.extract(events, []);

    expect(count).toBe(0);
  });

  it('LLM 返回空 memories 数组 → 返回 0', async () => {
    const json = JSON.stringify({ memories: [] });
    const fake = new FakeLLMClient([{ text: json, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['help me set up the project with typescript and eslint configuration', 'sure, I will help you set up typescript with eslint']]);
    const count = await extractor.extract(events, []);

    expect(count).toBe(0);
  });

  it('existingTitles 传入 prompt 用于去重参考', async () => {
    const json = JSON.stringify({ memories: [] });
    const fake = new FakeLLMClient([{ text: json, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['help me set up the project with typescript and eslint configuration files', 'sure, I will help you set up the project']]);
    await extractor.extract(events, ['Existing memory 1', 'Existing memory 2']);

    const request = fake.requests[0];
    expect(request?.system).toContain('Existing memory 1');
    expect(request?.system).toContain('Existing memory 2');
  });

  it('LLM 调用失败 → 返回 0（不崩）', async () => {
    const failingClient = {
      name: 'failing',
      model: 'test-model',
      chat: () => Promise.reject(new Error('network error')),
    };
    const extractor = new MemoryExtractor(failingClient, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['help me set up the project with typescript and eslint configuration', 'sure, I will help you set up typescript with eslint']]);
    const count = await extractor.extract(events, []);

    expect(count).toBe(0);
  });

  it('程序化去重：与已有标题归一化相同则跳过', async () => {
    const json = JSON.stringify({
      memories: [
        { title: 'TypeScript Strict', content: 'x', category: 'preference', description: 'd', keywords: ['a'] },
        { title: 'New Memory', content: 'y', category: 'general', description: 'd2', keywords: ['b'] },
      ],
    });
    const fake = new FakeLLMClient([{ text: json, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['help me set up typescript with strict mode enabled please', 'sure, I will enable strict mode in your tsconfig file']]);
    const count = await extractor.extract(events, ['typescript strict']);

    expect(count).toBe(1);
    const memories = await store.listActive();
    expect(memories.map((m) => m.title)).toEqual(['New Memory']);
  });

  it('minChars 选项生效：低于阈值不调 LLM', async () => {
    const fake = new FakeLLMClient([]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['hello world', 'hi there']]);
    const count = await extractor.extract(events, [], { minChars: 500 });

    expect(count).toBe(0);
    expect(fake.consumed).toBe(0);
  });

  it('onUsage 回调收到真实用量', async () => {
    const json = JSON.stringify({ memories: [] });
    const fake = new FakeLLMClient([{ text: json, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 42, outputTokens: 7 } }]);
    const usages: { inputTokens: number; outputTokens: number; model: string }[] = [];
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER, 0, (u) => usages.push(u));

    const events = makeEvents('s1', [['help me set up the project with typescript and eslint configuration', 'sure, I will help you set up typescript with eslint']]);
    await extractor.extract(events, []);

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ inputTokens: 42, outputTokens: 7 });
  });
});

describe('MemoryExtractor 价值闸门', () => {
  const LONG_TURN: [string, string][] = [
    [
      'help me set up the project with typescript and eslint configuration',
      'sure, I will help you set up typescript with eslint',
    ],
  ];

  function client(memories: unknown[]): FakeLLMClient {
    return new FakeLLMClient([
      {
        text: JSON.stringify({ memories }),
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);
  }

  it('importance 低于阈值 → 不落库', async () => {
    const fake = client([
      {
        title: 'Trivial remark',
        content: 'x',
        category: 'general',
        description: 'd',
        keywords: ['a'],
        importance: 2,
        durability: 'durable',
      },
    ]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    const count = await extractor.extract(makeEvents('s1', LONG_TURN), []);
    expect(count).toBe(0);
    expect(await store.listActive()).toHaveLength(0);
  });

  it('importance 达标 → 落库并保留分数', async () => {
    const fake = client([
      {
        title: 'Important fact',
        content: 'x',
        category: 'general',
        description: 'd',
        keywords: ['a'],
        importance: 9,
        durability: 'durable',
      },
    ]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    expect(await extractor.extract(makeEvents('s1', LONG_TURN), [])).toBe(1);
    const [m] = await store.listActive();
    expect(m?.importance).toBe(9);
  });

  it('minImportance 可配置', async () => {
    const fake = client([
      {
        title: 'Medium fact',
        content: 'x',
        category: 'general',
        description: 'd',
        keywords: ['a'],
        importance: 5,
        durability: 'durable',
      },
    ]);
    const extractor = new MemoryExtractor(fake, store, SILENT_LOGGER);

    expect(await extractor.extract(makeEvents('s1', LONG_TURN), [], { minImportance: 6 })).toBe(0);
  });
});

describe('MemoryExtractor 稳定槽位与时效', () => {
  const LONG_TURN: [string, string][] = [
    [
      'my name is yang, please remember it for future sessions',
      'got it, I will remember that your name is yang from now on',
    ],
  ];

  function client(memories: unknown[]): FakeLLMClient {
    return new FakeLLMClient([
      {
        text: JSON.stringify({ memories }),
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);
  }

  it('带 key 的候选走 upsert：同一槽位只保留最新值', async () => {
    const first = new MemoryExtractor(
      client([
        {
          title: 'User name',
          content: 'The user name is yang',
          category: 'general',
          description: 'user name',
          keywords: ['name'],
          importance: 9,
          durability: 'durable',
          key: 'profile.name',
        },
      ]),
      store,
      SILENT_LOGGER,
    );
    expect(await first.extract(makeEvents('s1', LONG_TURN), [])).toBe(1);

    const second = new MemoryExtractor(
      client([
        {
          title: 'User name',
          content: 'The user name is Yang Yang',
          category: 'general',
          description: 'user name',
          keywords: ['name'],
          importance: 9,
          durability: 'durable',
          key: 'profile.name',
        },
      ]),
      store,
      SILENT_LOGGER,
    );
    expect(await second.extract(makeEvents('s1', LONG_TURN), [])).toBe(1);

    const all = await store.listActive();
    expect(all).toHaveLength(1);
    expect(all[0]?.content).toBe('The user name is Yang Yang');
    expect(all[0]?.key).toBe('profile.name');
  });

  it('不同 key 的候选各自成行', async () => {
    const extractor = new MemoryExtractor(
      client([
        {
          title: 'Editor',
          content: 'Editor is vim',
          category: 'general',
          description: 'editor',
          keywords: ['editor'],
          importance: 7,
          durability: 'durable',
          key: 'preference.editor',
        },
        {
          title: 'Terminal',
          content: 'Terminal is ghostty',
          category: 'general',
          description: 'terminal',
          keywords: ['terminal'],
          importance: 7,
          durability: 'durable',
          key: 'preference.terminal',
        },
      ]),
      store,
      SILENT_LOGGER,
    );

    expect(await extractor.extract(makeEvents('s1', LONG_TURN), [])).toBe(2);
    expect(await store.listActive()).toHaveLength(2);
  });

  it('ephemeral + expiresInDays → 写入过期时间且当前可见', async () => {
    const extractor = new MemoryExtractor(
      client([
        {
          title: 'Current sprint goal',
          content: 'Ship the memory v9 migration',
          category: 'general',
          description: 'sprint goal',
          keywords: ['sprint'],
          importance: 5,
          durability: 'ephemeral',
          expiresInDays: 7,
        },
      ]),
      store,
      SILENT_LOGGER,
    );

    expect(await extractor.extract(makeEvents('s1', LONG_TURN), [])).toBe(1);
    const [m] = await store.listActive();
    expect(m?.durability).toBe('ephemeral');
    expect(m?.expiresAt).toBeDefined();
    expect(new Date(m!.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('ephemeral 未给 TTL → 套用默认天数', async () => {
    const extractor = new MemoryExtractor(
      client([
        {
          title: 'Temporary workaround',
          content: 'Pin sqlite-vec to 0.1.9',
          category: 'general',
          description: 'workaround',
          keywords: ['workaround'],
          importance: 5,
          durability: 'ephemeral',
        },
      ]),
      store,
      SILENT_LOGGER,
    );

    await extractor.extract(makeEvents('s1', LONG_TURN), [], { defaultEphemeralTtlDays: 3 });
    const [m] = await store.listActive();
    expect(m?.expiresAt).toBeDefined();
    expect(new Date(m!.expiresAt!).getTime()).toBeLessThan(Date.now() + 3 * 86400_000 + 3600_000);
  });

  it('durable 类别（preference）强制 durable + pinned 且不过期', async () => {
    const extractor = new MemoryExtractor(
      client([
        {
          title: 'Language preference',
          content: 'User replies should be in English',
          category: 'preference',
          description: 'language',
          keywords: ['language'],
          importance: 8,
          durability: 'ephemeral',
          expiresInDays: 1,
        },
      ]),
      store,
      SILENT_LOGGER,
    );

    await extractor.extract(makeEvents('s1', LONG_TURN), []);
    const [m] = await store.listActive();
    expect(m?.durability).toBe('durable');
    expect(m?.pinned).toBe(true);
    expect(m?.expiresAt).toBeUndefined();
  });
});
