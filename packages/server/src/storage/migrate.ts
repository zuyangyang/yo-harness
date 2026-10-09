/**
 * PostgreSQL 迁移脚本：在指定 schema 下创建全部表。
 *
 * 每个租户对应一个独立 schema（`tenant_<id>`），
 * 迁移时先 `SET search_path` 再建表。
 */
import type { PoolClient } from 'pg';

export async function runMigrations(client: PoolClient, schemaName: string): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await client.query(`SET search_path TO "${schemaName}", public`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      color       TEXT,
      icon        TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_workspaces_sort ON workspaces (sort_order, created_at)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL DEFAULT '',
      model           TEXT NOT NULL,
      cwd             TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      type            TEXT NOT NULL DEFAULT 'interactive',
      workspace_id    TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      pinned          BOOLEAN NOT NULL DEFAULT FALSE,
      title_is_custom BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `);

  // 存量库升级：新列幂等追加（ADD COLUMN IF NOT EXISTS 不校验类型，此处仅追加缺失列）
  await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL`);
  await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS title_is_custom BOOLEAN NOT NULL DEFAULT FALSE`);
  await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS permission_mode TEXT`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions (workspace_id, updated_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status, updated_at DESC)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS events (
      id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      seq        INTEGER NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, seq)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, seq)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      seq         INTEGER NOT NULL,
      source      TEXT NOT NULL,
      created_at  TEXT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints (session_id, seq)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS checkpoint_files (
      id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
      rel_path      TEXT NOT NULL,
      content       TEXT,
      UNIQUE (checkpoint_id, rel_path)
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_checkpoint_files_cp ON checkpoint_files (checkpoint_id)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      content           TEXT NOT NULL,
      category          TEXT NOT NULL,
      description       TEXT NOT NULL,
      keywords          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      source_session_id TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      description     TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running',
      pid             INTEGER,
      cwd             TEXT NOT NULL,
      model           TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      completed_at    TEXT,
      end_reason      TEXT,
      summary         TEXT,
      error_message   TEXT
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`);
  // 存量库升级：定时任务关联列
  await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_id TEXT`);
  await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS trigger TEXT NOT NULL DEFAULT 'manual'`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks (schedule_id, created_at DESC)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      prompt              TEXT NOT NULL,
      cron                TEXT NOT NULL,
      timezone            TEXT NOT NULL DEFAULT 'UTC',
      enabled             BOOLEAN NOT NULL DEFAULT TRUE,
      workspace_id        TEXT,
      cwd                 TEXT,
      model               TEXT,
      permission_mode     TEXT NOT NULL DEFAULT 'full',
      allowed_tools       TEXT,
      max_steps           INTEGER,
      max_tokens          INTEGER,
      max_duration_ms     INTEGER,
      output_kind         TEXT NOT NULL DEFAULT 'report',
      output_target       TEXT,
      overlap_policy      TEXT NOT NULL DEFAULT 'skip',
      catch_up_policy     TEXT NOT NULL DEFAULT 'skip',
      next_run_at         TEXT NOT NULL,
      last_run_at         TEXT,
      last_run_id         TEXT,
      last_status         TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks (enabled, next_run_at)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      session_id TEXT,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT,
      read_at    TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications (read_at, created_at DESC)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_username ON users (tenant_id, username)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL,
      role         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_used_at TEXT
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS model_providers (
      id                     TEXT PRIMARY KEY,
      display_name           TEXT NOT NULL,
      kind                   TEXT NOT NULL,
      base_url               TEXT,
      api_key_cipher         TEXT,
      api_key_hint           TEXT,
      api_key_env            TEXT,
      models_json            TEXT NOT NULL DEFAULT '[]',
      default_context_window INTEGER,
      sort_order             INTEGER NOT NULL DEFAULT 0,
      created_at             TEXT NOT NULL,
      updated_at             TEXT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_model_providers_sort ON model_providers (sort_order, created_at)`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS model_settings (
      id                 TEXT PRIMARY KEY,
      active_provider_id TEXT,
      active_model       TEXT,
      updated_at         TEXT NOT NULL
    )
  `);
}
