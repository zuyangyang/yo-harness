import { randomUUID } from 'node:crypto';

import type { Session, SessionListFilter, SessionStore, SessionUpdate } from '../core/ports.js';
import { FatalError } from '../types/errors.js';
import type { SqliteDatabase } from './db.js';

interface SessionRow {
  id: string;
  title: string;
  model: string;
  cwd: string;
  status: string;
  type: string;
  workspace_id: string | null;
  pinned: number;
  title_is_custom: number;
  created_at: string;
  updated_at: string;
}

/**
 * SQLite-backed SessionStore。端口为 async（为远程多租户存储预留），
 * 本实现内部同步、边界 async 化。title 空串表示"无标题"。
 */
export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: {
    model: string;
    cwd: string;
    title?: string;
    titleIsCustom?: boolean;
    workspaceId?: string | null;
    type?: 'interactive' | 'background';
  }): Promise<Session> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const type = input.type ?? 'interactive';
    const workspaceId = input.workspaceId ?? null;
    const titleIsCustom = input.titleIsCustom ?? false;

    this.db
      .prepare(
        `INSERT INTO sessions
         (id, title, model, cwd, status, type, workspace_id, pinned, title_is_custom, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.title ?? '',
        input.model,
        input.cwd,
        type,
        workspaceId,
        titleIsCustom ? 1 : 0,
        now,
        now,
      );

    return {
      id,
      title: input.title ?? '',
      model: input.model,
      cwd: input.cwd,
      status: 'active',
      type,
      workspaceId,
      pinned: false,
      titleIsCustom,
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

  async list(filter: SessionListFilter = {}): Promise<Session[]> {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];

    if (filter.workspaceId === null) {
      conditions.push('workspace_id IS NULL');
    } else if (filter.workspaceId !== undefined) {
      conditions.push('workspace_id = ?');
      params.push(filter.workspaceId);
    }

    conditions.push('status = ?');
    params.push(filter.status ?? 'active');

    if (filter.pinned !== undefined) {
      conditions.push('pinned = ?');
      params.push(filter.pinned ? 1 : 0);
    }

    if (filter.query !== undefined && filter.query.trim() !== '') {
      conditions.push('title LIKE ?');
      params.push(`%${filter.query.trim()}%`);
    }

    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;
    params.push(limit, offset);

    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE ${conditions.join(' AND ')}
         ORDER BY pinned DESC, updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params) as SessionRow[];
    return rows.map(mapSession);
  }

  async listRecent(limit: number): Promise<Session[]> {
    return this.list({ status: 'active', limit });
  }

  async touch(id: string): Promise<void> {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  async update(id: string, patch: SessionUpdate): Promise<Session | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.titleIsCustom !== undefined) {
      sets.push('title_is_custom = ?');
      params.push(patch.titleIsCustom ? 1 : 0);
    }
    if (patch.workspaceId !== undefined) {
      sets.push('workspace_id = ?');
      params.push(patch.workspaceId);
    }
    if (patch.pinned !== undefined) {
      sets.push('pinned = ?');
      params.push(patch.pinned ? 1 : 0);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db
      .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);

    return this.get(id);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.update(id, { title });
  }

  async delete(id: string): Promise<void> {
    const txn = this.db.transaction(() => {
      // FK 依赖顺序：checkpoint_files → checkpoints → events → sessions
      this.db
        .prepare(
          'DELETE FROM checkpoint_files WHERE checkpoint_id IN (SELECT id FROM checkpoints WHERE session_id = ?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id);
      this.db
        .prepare('UPDATE memories SET source_session_id = NULL WHERE source_session_id = ?')
        .run(id);
      this.db.prepare('DELETE FROM tasks WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
    txn();
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
    status: row.status,
    type,
    workspaceId: row.workspace_id,
    pinned: row.pinned === 1,
    titleIsCustom: row.title_is_custom === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
