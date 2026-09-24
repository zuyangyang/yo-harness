/**
 * SQLite 连接与 schema 管理。
 * 数据目录约定见 utils/paths；本模块只负责打开与初始化。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { FatalError } from '../types/errors.js';

export type SqliteDatabase = Database.Database;

const SCHEMA_VERSION = '1';

export function openDatabase(dbPath: string): SqliteDatabase {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      model      TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      seq        INTEGER NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, seq);
  `);

  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get('schema_version') as { value: string } | undefined;

  if (row === undefined) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      SCHEMA_VERSION,
    );
  } else if (row.value !== SCHEMA_VERSION) {
    throw new FatalError(
      `database schema version mismatch: db=${row.value}, code=${SCHEMA_VERSION}`,
    );
  }
}
