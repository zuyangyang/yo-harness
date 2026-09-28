import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

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

describe('Schema v2 → v3 迁移', () => {
  it('从 v2 升级到 v3：新表存在、旧数据完整、sessions.type 默认 interactive', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'yo-migrate-'));
    const dbPath = join(dbDir, 'test.db');

    // 手动构造一个 v2 数据库
    const v2 = new Database(dbPath);
    v2.pragma('journal_mode = WAL');
    v2.pragma('foreign_keys = ON');
    v2.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '2');

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL, cwd TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE (session_id, seq)
      );
      CREATE INDEX idx_events_session ON events (session_id, seq);

      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE checkpoint_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        rel_path TEXT NOT NULL, content BLOB, UNIQUE (checkpoint_id, rel_path)
      );

      INSERT INTO sessions VALUES ('s1', 'old session', 'claude-x', '/tmp', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO events (session_id, seq, type, payload, created_at) VALUES ('s1', 1, 'user_input', '{"type":"user_input","content":"hello"}', '2026-01-01T00:00:00Z');
    `);
    v2.close();

    // 用当前代码打开 → 触发 v2→v3 迁移
    const v3 = openDatabase(dbPath);

    // schema_version 已升级
    const version = (v3.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value;
    expect(version).toBe('3');

    // 旧数据完整
    const session = v3.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>;
    expect(session).toBeDefined();
    expect(session.title).toBe('old session');
    expect(session.type).toBe('interactive');

    const eventCount = (v3.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt;
    expect(eventCount).toBe(1);

    // 新表存在
    const tables = v3.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('memories');
    expect(tableNames).toContain('tasks');

    // FTS5 虚拟表存在
    const fts = v3.prepare("SELECT name FROM sqlite_master WHERE name='memories_fts'").all();
    expect(fts).toHaveLength(1);

    // sessions.type 列存在且有默认值
    const columns = v3.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(columns.some((c) => c.name === 'type')).toBe(true);

    v3.close();
    rmSync(dbDir, { recursive: true, force: true });
  });
});
