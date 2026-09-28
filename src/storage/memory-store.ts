import { randomUUID } from 'node:crypto';

import type { MemoryStore, MemorySearchOptions } from '../core/ports.js';
import type { Memory, MemoryCategory, MemoryStatus } from '../types/memory.js';
import type { SqliteDatabase } from './db.js';

interface MemoryRow {
  id: string;
  title: string;
  content: string;
  category: string;
  description: string;
  keywords: string;
  status: string;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * SQLite-backed MemoryStore。
 *
 * 内部同步、边界 async 化（与 SessionStore / EventStore 一致）。
 * FTS5 全文索引由 DB 迁移层的触发器自动同步，本类只管 CRUD。
 */
export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const memory: Memory = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO memories
         (id, title, content, category, description, keywords, status, source_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        memory.title,
        memory.content,
        memory.category,
        memory.description,
        JSON.stringify(memory.keywords),
        memory.status,
        memory.sourceSessionId ?? null,
        now,
        now,
      );

    return memory;
  }

  async get(id: string): Promise<Memory | undefined> {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    return row === undefined ? undefined : mapMemory(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<Memory, 'title' | 'content' | 'category' | 'description' | 'keywords' | 'status'>>,
  ): Promise<Memory | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;

    const now = new Date().toISOString();
    const merged: Memory = { ...existing, ...patch, updatedAt: now };

    this.db
      .prepare(
        `UPDATE memories
         SET title = ?, content = ?, category = ?, description = ?, keywords = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.content,
        merged.category,
        merged.description,
        JSON.stringify(merged.keywords),
        merged.status,
        now,
        id,
      );

    return merged;
  }

  async archive(id: string): Promise<void> {
    this.db
      .prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  async listActive(): Promise<Memory[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE status = 'active'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as MemoryRow[];
    return rows.map(mapMemory);
  }

  async search(query: string, options?: MemorySearchOptions): Promise<Memory[]> {
    const limit = options?.limit ?? 20;
    const category = options?.category;
    const status = options?.status ?? 'active';

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return this.listByFilter(category, status, limit);
    }

    const terms = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '')}"`)
      .join(' OR ');

    let sql: string;
    let params: unknown[];

    if (category !== undefined) {
      sql = `SELECT m.* FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.status = ? AND m.category = ?
             ORDER BY rank
             LIMIT ?`;
      params = [terms, status, category, limit];
    } else {
      sql = `SELECT m.* FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.status = ?
             ORDER BY rank
             LIMIT ?`;
      params = [terms, status, limit];
    }

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(mapMemory);
  }

  private listByFilter(
    category: MemoryCategory | undefined,
    status: MemoryStatus,
    limit: number,
  ): Memory[] {
    let sql: string;
    let params: unknown[];

    if (category !== undefined) {
      sql = `SELECT * FROM memories WHERE status = ? AND category = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?`;
      params = [status, category, limit];
    } else {
      sql = `SELECT * FROM memories WHERE status = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?`;
      params = [status, limit];
    }

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(mapMemory);
  }
}

function mapMemory(row: MemoryRow): Memory {
  let keywords: string[];
  try {
    keywords = JSON.parse(row.keywords) as string[];
  } catch {
    keywords = [];
  }

  const memory: Memory = {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category as MemoryCategory,
    description: row.description,
    keywords,
    status: row.status as MemoryStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.source_session_id !== null) {
    memory.sourceSessionId = row.source_session_id;
  }
  return memory;
}
