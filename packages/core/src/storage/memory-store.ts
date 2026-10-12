import { randomUUID } from 'node:crypto';

import type { MemoryStore, MemorySearchOptions } from '../core/ports.js';
import { applyMemoryPatch } from '../types/memory.js';
import type {
  Memory,
  MemoryCategory,
  MemoryCreateInput,
  MemoryDurability,
  MemoryStatus,
  MemoryUpdatePatch,
} from '../types/memory.js';
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
  key: string | null;
  importance: number;
  durability: string;
  confidence: number;
  pinned: number;
  expires_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  last_accessed_at: string | null;
  access_count: number;
  created_at: string;
  updated_at: string;
}

/** 写入时的默认值（v9 智能记忆元数据） */
export const DEFAULT_MEMORY_IMPORTANCE = 5;
export const DEFAULT_MEMORY_DURABILITY: MemoryDurability = 'durable';
export const DEFAULT_MEMORY_CONFIDENCE = 1;

/**
 * 未过期判定：expires_at 为空即永久；pinned 是逃生舱，免疫过期。
 * 语义是隐藏不是删除——过期行仍可通过 get(id) 取回，清除 expires_at 即恢复。
 */
const NOT_EXPIRED_SQL = "(expires_at IS NULL OR expires_at > ? OR pinned = 1)";

/**
 * SQLite-backed MemoryStore。
 *
 * 内部同步、边界 async 化（与 SessionStore / EventStore 一致）。
 * FTS5 全文索引由 DB 迁移层的触发器自动同步，本类只管 CRUD。
 */
export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: MemoryCreateInput): Promise<Memory> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const memory: Memory = {
      ...input,
      importance: input.importance ?? DEFAULT_MEMORY_IMPORTANCE,
      durability: input.durability ?? DEFAULT_MEMORY_DURABILITY,
      confidence: input.confidence ?? DEFAULT_MEMORY_CONFIDENCE,
      pinned: input.pinned ?? false,
      accessCount: 0,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO memories
         (id, title, content, category, description, keywords, status, source_session_id,
          key, importance, durability, confidence, pinned, expires_at, valid_from, valid_to,
          superseded_by, last_accessed_at, access_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.title,
        memory.content,
        memory.category,
        memory.description,
        JSON.stringify(memory.keywords),
        memory.status,
        memory.sourceSessionId ?? null,
        memory.key ?? null,
        memory.importance,
        memory.durability,
        memory.confidence,
        memory.pinned ? 1 : 0,
        memory.expiresAt ?? null,
        memory.validFrom ?? null,
        memory.validTo ?? null,
        memory.supersededBy ?? null,
        memory.lastAccessedAt ?? null,
        memory.accessCount,
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

  async update(id: string, patch: MemoryUpdatePatch): Promise<Memory | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;

    const now = new Date().toISOString();
    const merged = applyMemoryPatch(existing, patch, now);

    this.db
      .prepare(
        `UPDATE memories
         SET title = ?, content = ?, category = ?, description = ?, keywords = ?, status = ?,
             key = ?, importance = ?, durability = ?, confidence = ?, pinned = ?, expires_at = ?,
             valid_from = ?, valid_to = ?, superseded_by = ?, last_accessed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.content,
        merged.category,
        merged.description,
        JSON.stringify(merged.keywords),
        merged.status,
        merged.key ?? null,
        merged.importance,
        merged.durability,
        merged.confidence,
        merged.pinned ? 1 : 0,
        merged.expiresAt ?? null,
        merged.validFrom ?? null,
        merged.validTo ?? null,
        merged.supersededBy ?? null,
        merged.lastAccessedAt ?? null,
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

  /** 当前可信且未过期的记忆（按创建时间倒序） */
  async listActive(): Promise<Memory[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE status = 'active' AND ${NOT_EXPIRED_SQL}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(new Date().toISOString()) as MemoryRow[];
    return rows.map(mapMemory);
  }

  async search(query: string, options?: MemorySearchOptions): Promise<Memory[]> {
    const limit = options?.limit ?? 20;
    const category = options?.category;
    const status = options?.status ?? 'active';
    const now = new Date().toISOString();

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return this.listByFilter(category, status, limit, now);
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
             WHERE memories_fts MATCH ? AND m.status = ? AND m.category = ? AND ${NOT_EXPIRED_SQL}
             ORDER BY rank
             LIMIT ?`;
      params = [terms, status, category, now, limit];
    } else {
      sql = `SELECT m.* FROM memories m
             JOIN memories_fts f ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.status = ? AND ${NOT_EXPIRED_SQL}
             ORDER BY rank
             LIMIT ?`;
      params = [terms, status, now, limit];
    }

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    return rows.map(mapMemory);
  }

  private listByFilter(
    category: MemoryCategory | undefined,
    status: MemoryStatus,
    limit: number,
    now: string,
  ): Memory[] {
    let sql: string;
    let params: unknown[];

    if (category !== undefined) {
      sql = `SELECT * FROM memories WHERE status = ? AND category = ? AND ${NOT_EXPIRED_SQL}
             ORDER BY created_at DESC, rowid DESC LIMIT ?`;
      params = [status, category, now, limit];
    } else {
      sql = `SELECT * FROM memories WHERE status = ? AND ${NOT_EXPIRED_SQL}
             ORDER BY created_at DESC, rowid DESC LIMIT ?`;
      params = [status, now, limit];
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
    importance: row.importance,
    durability: row.durability as MemoryDurability,
    confidence: row.confidence,
    pinned: row.pinned !== 0,
    accessCount: row.access_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.source_session_id !== null) memory.sourceSessionId = row.source_session_id;
  if (row.key !== null) memory.key = row.key;
  if (row.expires_at !== null) memory.expiresAt = row.expires_at;
  if (row.valid_from !== null) memory.validFrom = row.valid_from;
  if (row.valid_to !== null) memory.validTo = row.valid_to;
  if (row.superseded_by !== null) memory.supersededBy = row.superseded_by;
  if (row.last_accessed_at !== null) memory.lastAccessedAt = row.last_accessed_at;
  return memory;
}
