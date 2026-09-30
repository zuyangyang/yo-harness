/**
 * PostgreSQL StorageBackend 实现。
 *
 * 使用 drizzle-orm + pg。schema-per-tenant 隔离：
 * 每个租户一个独立 schema，通过 `search_path` 切换。
 */
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc, asc, sql, count, or, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type {
  EventStore,
  SessionStore,
  CheckpointStore,
  MemoryStore,
  TaskStore,
  Session,
  CheckpointDetail,
  CheckpointFileInfo,
  CheckpointSummary,
  MemorySearchOptions,
} from '@yo-harness/core/core/ports.js';
import type { AgentEvent, EventEnvelope } from '@yo-harness/core/types/events.js';
import { AgentEventSchema } from '@yo-harness/core/types/events.js';
import type { Memory, MemoryCategory, MemoryStatus } from '@yo-harness/core/types/memory.js';
import type { BackgroundTask, BackgroundTaskStatus, CreateTaskInput } from '@yo-harness/core/daemon/types.js';

import type { StorageBackend } from './interface.js';
import { createTenantSchema, type TenantTables } from './schema.js';
import { runMigrations } from './migrate.js';
import { PostgresUserStore } from './user-store.js';
import { PostgresApiKeyStore } from './api-key-store.js';

export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

type Db = NodePgDatabase<Record<string, never>>;

export class PostgresBackend implements StorageBackend {
  readonly sessions: PostgresSessionStore;
  readonly events: PostgresEventStore;
  readonly checkpoints: PostgresCheckpointStore;
  readonly memories: PostgresMemoryStore;
  readonly tasks: PostgresTaskStore;
  readonly users: PostgresUserStore;
  readonly apiKeys: PostgresApiKeyStore;

  private readonly pool: Pool;
  private readonly tables: TenantTables;
  private db: Db;

  constructor(
    private readonly config: PostgresConfig,
    private readonly schemaName: string,
  ) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
    });
    this.tables = createTenantSchema(schemaName);
    this.db = drizzle(this.pool);

    this.sessions = new PostgresSessionStore(this);
    this.events = new PostgresEventStore(this);
    this.checkpoints = new PostgresCheckpointStore(this);
    this.memories = new PostgresMemoryStore(this);
    this.tasks = new PostgresTaskStore(this);
    this.users = new PostgresUserStore(this.db, this.tables);
    this.apiKeys = new PostgresApiKeyStore(this.db, this.tables);
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await runMigrations(client, this.schemaName);
    } finally {
      client.release();
    }
    this.db = drizzle(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  getTables(): TenantTables {
    return this.tables;
  }

  getDb(): Db {
    return this.db;
  }
}

// ─── SessionStore ───

class PostgresSessionStore implements SessionStore {
  constructor(private readonly backend: PostgresBackend) {}

  private get t() { return this.backend.getTables(); }
  private get db() { return this.backend.getDb(); }

  async create(input: { model: string; cwd: string; title?: string; type?: 'interactive' | 'background' }): Promise<Session> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const type = input.type ?? 'interactive';

    await this.db.insert(this.t.sessions).values({
      id,
      title: input.title ?? '',
      model: input.model,
      cwd: input.cwd,
      status: 'active',
      type,
      createdAt: now,
      updatedAt: now,
    });

    return { id, title: input.title ?? '', model: input.model, cwd: input.cwd, status: 'active', type, createdAt: now, updatedAt: now };
  }

  async get(id: string): Promise<Session | undefined> {
    const rows = await this.db.select().from(this.t.sessions).where(eq(this.t.sessions.id, id)).limit(1);
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  async listRecent(limit: number): Promise<Session[]> {
    const rows = await this.db.select().from(this.t.sessions)
      .where(eq(this.t.sessions.status, 'active'))
      .orderBy(desc(this.t.sessions.updatedAt))
      .limit(limit);
    return rows.map(mapSession);
  }

  async touch(id: string): Promise<void> {
    await this.db.update(this.t.sessions)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(this.t.sessions.id, id));
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.db.update(this.t.sessions)
      .set({ title })
      .where(eq(this.t.sessions.id, id));
  }
}

function mapSession(row: { id: string; title: string; model: string; cwd: string; status: string; type: string; createdAt: string; updatedAt: string }): Session {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    cwd: row.cwd,
    status: row.status as Session['status'],
    type: row.type as Session['type'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── EventStore ───

class PostgresEventStore implements EventStore {
  constructor(private readonly backend: PostgresBackend) {}

  private get t() { return this.backend.getTables(); }
  private get db() { return this.backend.getDb(); }

  async append(sessionId: string, event: AgentEvent): Promise<EventEnvelope> {
    const payload = AgentEventSchema.parse(event);
    const ts = new Date().toISOString();

    const lastSeqRows = await this.db
      .select({ seq: sql<number>`coalesce(max(${this.t.events.seq}), 0)` })
      .from(this.t.events)
      .where(eq(this.t.events.sessionId, sessionId));
    const seq = (lastSeqRows[0]?.seq ?? 0) + 1;

    const inserted = await this.db.insert(this.t.events).values({
      sessionId,
      seq,
      type: payload.type,
      payload: JSON.stringify(payload),
      createdAt: ts,
    }).returning({ id: this.t.events.id });

    if (!inserted[0]) throw new Error('failed to insert event');
    return { id: inserted[0].id, sessionId, seq, ts, payload };
  }

  async replay(sessionId: string): Promise<EventEnvelope[]> {
    const rows = await this.db.select().from(this.t.events)
      .where(eq(this.t.events.sessionId, sessionId))
      .orderBy(asc(this.t.events.seq));
    return rows.map(envelopeOf);
  }

  async lastSeq(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ seq: sql<number>`coalesce(max(${this.t.events.seq}), 0)` })
      .from(this.t.events)
      .where(eq(this.t.events.sessionId, sessionId));
    return rows[0]?.seq ?? 0;
  }
}

function envelopeOf(row: { id: number; sessionId: string; seq: number; type: string; payload: string; createdAt: string }): EventEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload);
  } catch {
    throw new Error(`corrupt event payload at id=${row.id}`);
  }
  const parsed = AgentEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`event payload schema validation failed at id=${row.id}: ${parsed.error.message}`);
  }
  return { id: row.id, sessionId: row.sessionId, seq: row.seq, ts: row.createdAt, payload: parsed.data };
}

// ─── CheckpointStore ───

class PostgresCheckpointStore implements CheckpointStore {
  constructor(private readonly backend: PostgresBackend) {}

  private get t() { return this.backend.getTables(); }
  private get db() { return this.backend.getDb(); }

  async create(input: { sessionId: string; seq: number; source: 'auto_write' | 'auto_undo' | 'manual'; files: CheckpointFileInfo[] }): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.db.insert(this.t.checkpoints).values({
      id,
      sessionId: input.sessionId,
      seq: input.seq,
      source: input.source,
      createdAt: now,
    });

    for (const file of input.files) {
      await this.db.insert(this.t.checkpointFiles).values({
        checkpointId: id,
        relPath: file.relPath,
        content: file.content ? file.content.toString('base64') : null,
      });
    }

    return id;
  }

  async get(checkpointId: string): Promise<CheckpointDetail | undefined> {
    const cpRows = await this.db.select({
      id: this.t.checkpoints.id,
      source: this.t.checkpoints.source,
      createdAt: this.t.checkpoints.createdAt,
    }).from(this.t.checkpoints).where(eq(this.t.checkpoints.id, checkpointId)).limit(1);

    if (cpRows.length === 0) return undefined;
    const cp = cpRows[0]!;

    const fileRows = await this.db.select({
      relPath: this.t.checkpointFiles.relPath,
      hasContent: sql<boolean>`${this.t.checkpointFiles.content} IS NOT NULL`,
    }).from(this.t.checkpointFiles)
      .where(eq(this.t.checkpointFiles.checkpointId, checkpointId))
      .orderBy(asc(this.t.checkpointFiles.relPath));

    return {
      id: cp.id,
      source: cp.source,
      createdAt: cp.createdAt,
      files: fileRows.map((f) => ({ relPath: f.relPath, hasContent: f.hasContent })),
    };
  }

  async listBySession(sessionId: string): Promise<CheckpointSummary[]> {
    const rows = await this.db
      .select({
        id: this.t.checkpoints.id,
        seq: this.t.checkpoints.seq,
        source: this.t.checkpoints.source,
        createdAt: this.t.checkpoints.createdAt,
        fileCount: count(this.t.checkpointFiles.id),
      })
      .from(this.t.checkpoints)
      .leftJoin(this.t.checkpointFiles, eq(this.t.checkpointFiles.checkpointId, this.t.checkpoints.id))
      .where(eq(this.t.checkpoints.sessionId, sessionId))
      .groupBy(this.t.checkpoints.id, this.t.checkpoints.seq, this.t.checkpoints.source, this.t.checkpoints.createdAt)
      .orderBy(asc(this.t.checkpoints.seq));

    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      source: r.source,
      createdAt: r.createdAt,
      fileCount: r.fileCount,
    }));
  }

  async readFileContent(checkpointId: string, relPath: string): Promise<Buffer | null> {
    const rows = await this.db.select({ content: this.t.checkpointFiles.content })
      .from(this.t.checkpointFiles)
      .where(and(
        eq(this.t.checkpointFiles.checkpointId, checkpointId),
        eq(this.t.checkpointFiles.relPath, relPath),
      ))
      .limit(1);
    const raw = rows[0]?.content;
    return raw ? Buffer.from(raw, 'base64') : null;
  }

  async getAdjacent(sessionId: string, currentSeq: number, direction: 'prev' | 'next'): Promise<{ id: string; seq: number } | undefined> {
    const cmp = direction === 'prev'
      ? sql`${this.t.checkpoints.seq} < ${currentSeq}`
      : sql`${this.t.checkpoints.seq} > ${currentSeq}`;
    const order = direction === 'prev' ? desc(this.t.checkpoints.seq) : asc(this.t.checkpoints.seq);

    const rows = await this.db.select({
      id: this.t.checkpoints.id,
      seq: this.t.checkpoints.seq,
    }).from(this.t.checkpoints)
      .where(and(eq(this.t.checkpoints.sessionId, sessionId), cmp))
      .orderBy(order)
      .limit(1);

    return rows[0] ? { id: rows[0].id, seq: rows[0].seq } : undefined;
  }
}

// ─── MemoryStore ───

class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly backend: PostgresBackend) {}

  private get t() { return this.backend.getTables(); }
  private get db() { return this.backend.getDb(); }

  async create(input: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const memory: Memory = { ...input, id, createdAt: now, updatedAt: now };

    await this.db.insert(this.t.memories).values({
      id: memory.id,
      title: memory.title,
      content: memory.content,
      category: memory.category,
      description: memory.description,
      keywords: JSON.stringify(memory.keywords),
      status: memory.status,
      sourceSessionId: memory.sourceSessionId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return memory;
  }

  async get(id: string): Promise<Memory | undefined> {
    const rows = await this.db.select().from(this.t.memories).where(eq(this.t.memories.id, id)).limit(1);
    return rows[0] ? mapMemory(rows[0]) : undefined;
  }

  async update(id: string, patch: Partial<Pick<Memory, 'title' | 'content' | 'category' | 'description' | 'keywords' | 'status'>>): Promise<Memory | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const merged: Memory = { ...existing, ...patch, updatedAt: now };

    await this.db.update(this.t.memories)
      .set({
        title: merged.title,
        content: merged.content,
        category: merged.category,
        description: merged.description,
        keywords: JSON.stringify(merged.keywords),
        status: merged.status,
        updatedAt: now,
      })
      .where(eq(this.t.memories.id, id));

    return merged;
  }

  async archive(id: string): Promise<void> {
    await this.db.update(this.t.memories)
      .set({ status: 'archived', updatedAt: new Date().toISOString() })
      .where(eq(this.t.memories.id, id));
  }

  async listActive(): Promise<Memory[]> {
    const rows = await this.db.select().from(this.t.memories)
      .where(eq(this.t.memories.status, 'active'))
      .orderBy(desc(this.t.memories.createdAt));
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

    const terms = trimmed.split(/\s+/).filter(Boolean);
    const conditions = terms.map((t) =>
      or(
        like(this.t.memories.title, `%${t}%`),
        like(this.t.memories.description, `%${t}%`),
        like(this.t.memories.content, `%${t}%`),
        like(this.t.memories.keywords, `%${t}%`),
      ),
    );

    const q = this.db.select().from(this.t.memories)
      .where(and(
        eq(this.t.memories.status, status),
        or(...conditions),
        category ? eq(this.t.memories.category, category) : undefined,
      ))
      .orderBy(desc(this.t.memories.createdAt))
      .limit(limit);

    const rows = await q;
    return rows.map(mapMemory);
  }

  private async listByFilter(category: MemoryCategory | undefined, status: MemoryStatus, limit: number): Promise<Memory[]> {
    const rows = await this.db.select().from(this.t.memories)
      .where(and(
        eq(this.t.memories.status, status),
        category ? eq(this.t.memories.category, category) : undefined,
      ))
      .orderBy(desc(this.t.memories.createdAt))
      .limit(limit);
    return rows.map(mapMemory);
  }
}

function mapMemory(row: {
  id: string; title: string; content: string; category: string;
  description: string; keywords: string; status: string;
  sourceSessionId: string | null; createdAt: string; updatedAt: string;
}): Memory {
  let keywords: string[];
  try { keywords = JSON.parse(row.keywords) as string[]; } catch { keywords = []; }

  const memory: Memory = {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category as MemoryCategory,
    description: row.description,
    keywords,
    status: row.status as MemoryStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.sourceSessionId) memory.sourceSessionId = row.sourceSessionId;
  return memory;
}

// ─── TaskStore ───

class PostgresTaskStore implements TaskStore {
  constructor(private readonly backend: PostgresBackend) {}

  private get t() { return this.backend.getTables(); }
  private get db() { return this.backend.getDb(); }

  async create(input: CreateTaskInput): Promise<BackgroundTask> {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    await this.db.insert(this.t.sessions).values({
      id: sessionId,
      title: input.description.slice(0, 60),
      model: input.model,
      cwd: input.cwd,
      status: 'active',
      type: 'background',
      createdAt: now,
      updatedAt: now,
    });

    await this.db.insert(this.t.tasks).values({
      id: taskId,
      description: input.description,
      sessionId,
      status: 'pending',
      cwd: input.cwd,
      model: input.model,
      createdAt: now,
    });

    return {
      id: taskId,
      sessionId,
      description: input.description,
      status: 'pending',
      pid: null,
      endReason: null,
      completedAt: null,
      summary: null,
      errorMessage: null,
      createdAt: now,
      cwd: input.cwd,
      model: input.model,
    };
  }

  async get(id: string): Promise<BackgroundTask | undefined> {
    const rows = await this.db.select().from(this.t.tasks).where(eq(this.t.tasks.id, id)).limit(1);
    return rows[0] ? mapTask(rows[0]) : undefined;
  }

  async list(limit = 50): Promise<BackgroundTask[]> {
    const rows = await this.db.select().from(this.t.tasks)
      .orderBy(desc(this.t.tasks.createdAt))
      .limit(limit);
    return rows.map(mapTask);
  }

  async updateStatus(id: string, status: BackgroundTaskStatus, endReason?: BackgroundTask['endReason'], errorMessage?: string, summary?: string): Promise<void> {
    const now = new Date().toISOString();
    const completedAt = ['completed', 'failed', 'cancelled'].includes(status) ? now : null;

    await this.db.update(this.t.tasks)
      .set({ status, endReason: endReason ?? null, completedAt, errorMessage: errorMessage ?? null, summary: summary ?? null })
      .where(eq(this.t.tasks.id, id));
  }
}

function mapTask(row: {
  id: string; description: string; sessionId: string; status: string;
  pid: number | null; cwd: string; model: string; createdAt: string;
  completedAt: string | null; endReason: string | null;
  summary: string | null; errorMessage: string | null;
}): BackgroundTask {
  return {
    id: row.id,
    sessionId: row.sessionId,
    description: row.description,
    status: row.status as BackgroundTaskStatus,
    pid: row.pid,
    endReason: row.endReason as BackgroundTask['endReason'],
    completedAt: row.completedAt,
    summary: row.summary,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    cwd: row.cwd,
    model: row.model,
  };
}

// ─── Factory ───

export function createPostgresBackend(config: PostgresConfig, schemaName: string): PostgresBackend {
  return new PostgresBackend(config, schemaName);
}
