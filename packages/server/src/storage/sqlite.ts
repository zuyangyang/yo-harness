/**
 * SQLite StorageBackend：包装 Phase 1-3 的各 SQLite store 为统一接口。
 *
 * 单租户模式直接使用本地 SQLite 文件，零配置。
 */
import type { SqliteDatabase } from '@yo-harness/core/storage/db.js';
import { openDatabase } from '@yo-harness/core/storage/db.js';
import { SqliteEventStore } from '@yo-harness/core/storage/event-store.js';
import { SqliteSessionStore } from '@yo-harness/core/storage/session-store.js';
import { SqliteCheckpointStore } from '@yo-harness/core/storage/checkpoint-store.js';
import { SqliteMemoryStore } from '@yo-harness/core/storage/memory-store.js';
import { SqliteTaskStore } from '@yo-harness/core/storage/task-store.js';
import { SqliteWorkspaceStore } from '@yo-harness/core/storage/workspace-store.js';
import { SqliteModelConfigStore } from '@yo-harness/core/storage/model-config-store.js';
import { SqliteUserStore } from './sqlite-user-store.js';
import { SqliteApiKeyStore } from './sqlite-api-key-store.js';
import type { StorageBackend } from './interface.js';

export class SqliteBackend implements StorageBackend {
  readonly sessions: SqliteSessionStore;
  readonly workspaces: SqliteWorkspaceStore;
  readonly modelConfig: SqliteModelConfigStore;
  readonly events: SqliteEventStore;
  readonly checkpoints: SqliteCheckpointStore;
  readonly memories: SqliteMemoryStore;
  readonly tasks: SqliteTaskStore;
  readonly users: SqliteUserStore;
  readonly apiKeys: SqliteApiKeyStore;

  constructor(private readonly db: SqliteDatabase) {
    this.sessions = new SqliteSessionStore(db);
    this.workspaces = new SqliteWorkspaceStore(db);
    this.modelConfig = new SqliteModelConfigStore(db);
    this.events = new SqliteEventStore(db);
    this.checkpoints = new SqliteCheckpointStore(db);
    this.memories = new SqliteMemoryStore(db);
    this.tasks = new SqliteTaskStore(db);
    this.users = new SqliteUserStore(db);
    this.apiKeys = new SqliteApiKeyStore(db);
  }

  async initialize(): Promise<void> {
    // schema 已在 openDatabase() 中初始化，无需额外操作
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function createSqliteBackend(dbPath: string): SqliteBackend {
  const db = openDatabase(dbPath);
  return new SqliteBackend(db);
}
