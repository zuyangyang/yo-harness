import { randomUUID } from 'node:crypto';

import type { Workspace, WorkspaceStore } from '../core/ports.js';
import type { SqliteDatabase } from './db.js';

interface WorkspaceRow {
  id: string;
  name: string;
  description: string;
  color: string | null;
  icon: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  session_count: number;
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: {
    name: string;
    description?: string;
    color?: string;
    icon?: string;
    sortOrder?: number;
  }): Promise<Workspace> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const description = input.description ?? '';
    const color = input.color ?? null;
    const icon = input.icon ?? null;
    const sortOrder = input.sortOrder ?? 0;

    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, description, color, icon, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, description, color, icon, sortOrder, now, now);

    return {
      id,
      name: input.name,
      description,
      color,
      icon,
      sortOrder,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(id: string): Promise<Workspace | undefined> {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
    return row === undefined ? undefined : mapWorkspace(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'sortOrder'>>,
  ): Promise<Workspace | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(patch.description);
    }
    if (patch.color !== undefined) {
      sets.push('color = ?');
      params.push(patch.color);
    }
    if (patch.icon !== undefined) {
      sets.push('icon = ?');
      params.push(patch.icon);
    }
    if (patch.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      params.push(patch.sortOrder);
    }

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db
      .prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);

    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    // sessions.workspace_id 通过 FK ON DELETE SET NULL 自动解绑为独立会话
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  async list(): Promise<Workspace[]> {
    const rows = this.db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM sessions s
           WHERE s.workspace_id = w.id AND s.status = 'active') AS session_count
         FROM workspaces w
         ORDER BY w.sort_order ASC, w.created_at ASC`,
      )
      .all() as WorkspaceRow[];
    return rows.map(mapWorkspace);
  }
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count,
  };
}
