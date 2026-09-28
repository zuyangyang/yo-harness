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
      chat: () => Promise.reject(new Error('network error')),
    };
    const extractor = new MemoryExtractor(failingClient, store, SILENT_LOGGER);

    const events = makeEvents('s1', [['help me set up the project with typescript and eslint configuration', 'sure, I will help you set up typescript with eslint']]);
    const count = await extractor.extract(events, []);

    expect(count).toBe(0);
  });
});
