/**
 * StorageBackend 抽象：屏蔽 SQLite / PostgreSQL 差异。
 *
 * 单租户模式用 SQLite（零配置），多租户模式用 PostgreSQL（schema-per-tenant）。
 * Server 层只依赖此接口，不关心底层存储引擎。
 */
import type {
  EventStore,
  SessionStore,
  CheckpointStore,
  MemoryStore,
  TaskStore,
} from '@yo-harness/core/core/ports.js';
import type { UserStore } from './user-store.js';
import type { ApiKeyStore } from './api-key-store.js';

export type {
  EventStore,
  SessionStore,
  CheckpointStore,
  MemoryStore,
  TaskStore,
} from '@yo-harness/core/core/ports.js';

export type { UserStore } from './user-store.js';
export type { ApiKeyStore } from './api-key-store.js';

export interface StorageBackend {
  sessions: SessionStore;
  events: EventStore;
  checkpoints: CheckpointStore;
  memories: MemoryStore;
  tasks: TaskStore;
  users: UserStore;
  apiKeys: ApiKeyStore;

  initialize(): Promise<void>;
  close(): Promise<void>;
}
