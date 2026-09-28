/**
 * yo-harness headless server 入口。
 */

export {
  SqliteBackend,
  createSqliteBackend,
  PostgresBackend,
  createPostgresBackend,
} from './storage/index.js';
export type { StorageBackend, PostgresConfig } from './storage/index.js';

export function createServer(): void {
  // TODO: Step 4 — Hono app 装配
}

export function startServer(_port: number): void {
  // TODO: Step 4 — 启动 HTTP + WebSocket 服务
  console.log('[yo-server] skeleton — not yet implemented');
}
