import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../src/types/events.js';
import type { SqliteDatabase } from '../src/storage/db.js';
import { openDatabase } from '../src/storage/db.js';
import { SqliteEventStore } from '../src/storage/event-store.js';
import { SqliteSessionStore } from '../src/storage/session-store.js';

let dir: string;
let db: SqliteDatabase;
let events: SqliteEventStore;
let sessionId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yo-events-'));
  db = openDatabase(join(dir, 'test.db'));
  events = new SqliteEventStore(db);
  sessionId = (await new SqliteSessionStore(db).create({ model: 'test-model', cwd: dir })).id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const userInput = (content: string): AgentEvent => ({ type: 'user_input', content });
const assistantText = (text: string): AgentEvent => ({
  type: 'assistant_text',
  text,
  toolCalls: [],
});

describe('SqliteEventStore', () => {
  it('append 分配单调递增的 seq', async () => {
    await events.append(sessionId, userInput('a'));
    const second = await events.append(sessionId, assistantText('b'));
    const third = await events.append(sessionId, userInput('c'));

    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
    expect(await events.lastSeq(sessionId)).toBe(3);
  });

  it('replay 按 seq 升序返回且 envelope 字段完整', async () => {
    await events.append(sessionId, userInput('a'));
    await events.append(sessionId, assistantText('b'));
    await events.append(sessionId, userInput('c'));

    const envelopes = await events.replay(sessionId);

    expect(envelopes.map((e) => e.payload.type)).toEqual([
      'user_input',
      'assistant_text',
      'user_input',
    ]);
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (const envelope of envelopes) {
      expect(envelope.sessionId).toBe(sessionId);
      expect(envelope.id).toBeGreaterThan(0);
      expect(envelope.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('未知 sessionId 的 replay/lastSeq 返回空/0', async () => {
    expect(await events.replay('no-such-session')).toEqual([]);
    expect(await events.lastSeq('no-such-session')).toBe(0);
  });

  it('schema 不合法的事件在 append 时被拒绝', async () => {
    await expect(
      events.append(sessionId, { type: 'user_input' } as unknown as AgentEvent),
    ).rejects.toThrow();
    expect(await events.lastSeq(sessionId)).toBe(0);
  });

  it('不同 session 的 seq 相互独立', async () => {
    const otherId = (await new SqliteSessionStore(db).create({ model: 'm', cwd: dir })).id;
    await events.append(sessionId, userInput('a'));
    await events.append(otherId, userInput('x'));
    const envelope = await events.append(sessionId, assistantText('b'));

    expect(envelope.seq).toBe(2);
    expect(await events.lastSeq(otherId)).toBe(1);
  });

  it('replay 对损坏 payload 抛 FatalError 而非静默返回', async () => {
    await events.append(sessionId, userInput('a'));
    db.prepare('UPDATE events SET payload = ? WHERE session_id = ?').run('{not json', sessionId);

    await expect(events.replay(sessionId)).rejects.toThrow(/corrupt|schema/i);
  });

  it('重复打开同一数据库不重复建表、数据可续读', async () => {
    await events.append(sessionId, userInput('persisted'));
    const dbPath = join(dir, 'test.db');
    db.close();

    const reopened = openDatabase(dbPath);
    const reopenedStore = new SqliteEventStore(reopened);
    const envelopes = await reopenedStore.replay(sessionId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.payload).toEqual({ type: 'user_input', content: 'persisted' });
    reopened.close();
  });
});
