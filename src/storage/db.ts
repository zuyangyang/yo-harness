/**
 * SQLite 连接与 schema 管理。
 * 数据目录约定见 utils/paths；本模块只负责打开与初始化。
 *
 * Schema 版本演进：
 * - v1（Phase 1）：meta / sessions / events
 * - v2（Phase 2）：+ checkpoints / checkpoint_files
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { FatalError } from '../types/errors.js';

export type SqliteDatabase = Database.Database;

const SCHEMA_VERSION = '2';

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
  // 基础表（v1 起即存在）
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
    // 全新数据库：先标记 v1，再走迁移流程统一升到最新版
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  }

  // 按版本号逐步迁移（事务包裹，保证原子性）
  const currentVersion = (
    db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }
  ).value;

  if (currentVersion === '1') {
    migrateV1ToV2(db);
  } else if (currentVersion !== SCHEMA_VERSION) {
    throw new FatalError(
      `database schema version mismatch: db=${currentVersion}, code=${SCHEMA_VERSION}`,
    );
  }
}

/** v1 → v2：新增检查点相关表 */
function migrateV1ToV2(db: SqliteDatabase): void {
  const migration = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        seq         INTEGER NOT NULL,
        source      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints (session_id, seq);

      CREATE TABLE IF NOT EXISTS checkpoint_files (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
        rel_path      TEXT NOT NULL,
        content       BLOB,
        UNIQUE (checkpoint_id, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoint_files_cp ON checkpoint_files (checkpoint_id);
    `);
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('2', 'schema_version');
  });
  migration();
}
