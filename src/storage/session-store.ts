import { randomUUID } from 'node:crypto';

import type { Session, SessionStore } from '../core/ports.js';
import { FatalError } from '../types/errors.js';
import type { SqliteDatabase } from './db.js';

interface SessionRow {
  id: string;
  title: string;
  model: string;
  cwd: string;
  status: string;
  type: string;
  created_at: string;
  updated_at: string;
}

/**
 * SQLite-backed SessionStore。端口为 async（为远程多租户存储预留），
 * 本实现内部同步、边界 async 化。title 空串表示"无标题"。
 */
export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: { model: string; cwd: string; title?: string; type?: 'interactive' | 'background' }): Promise<Session> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const type = input.type ?? 'interactive';
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, model, cwd, status, type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, input.title ?? '', input.model, input.cwd, type, now, now);
    return {
      id,
      title: input.title ?? '',
      model: input.model,
      cwd: input.cwd,
      status: 'active',
      type,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(id: string): Promise<Session | undefined> {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row === undefined ? undefined : mapSession(row);
  }

  async listRecent(limit: number): Promise<Session[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE status = 'active'
         ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as SessionRow[];
    return rows.map(mapSession);
  }

  async touch(id: string): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
  }
}

function mapSession(row: SessionRow): Session {
  if (row.status !== 'active' && row.status !== 'archived') {
    throw new FatalError(`unknown session status '${row.status}' for id=${row.id}`);
  }
  const type = row.type === 'background' ? 'background' : 'interactive';
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    cwd: row.cwd,
    status: row.status as 'active' | 'archived',
    type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
