/**
 * PostgreSQL StorageBackend 实现。
 *
 * 使用 drizzle-orm + pg。schema-per-tenant 隔离：
 * 每个租户一个独立 schema，通过 `search_path` 切换。
 */
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, and, desc, asc, sql, count, or, like, isNull, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type {
  EventStore,
  SessionStore,
  CheckpointStore,
  MemoryStore,
  TaskStore,
  WorkspaceStore,
  ModelConfigStore,
  Session,
  SessionListFilter,
  SessionUpdate,
  Workspace,
  CheckpointDetail,
  CheckpointFileInfo,
  CheckpointSummary,
  MemorySearchOptions,
} from '@yo-harness/core/core/ports.js';
import type { AgentEvent, EventEnvelope } from '@yo-harness/core/types/events.js';
import { AgentEventSchema } from '@yo-harness/core/types/events.js';
import type { Memory, MemoryCategory, MemoryStatus } from '@yo-harness/core/types/memory.js';
import type { BackgroundTask, BackgroundTaskStatus, CreateTaskInput } from '@yo-harness/core/daemon/types.js';
import type { ModelSelection, ProviderRecord, ProviderRecordInput } from '@yo-harness/core/types/model-config.js';
import { parseModelsJson } from '@yo-harness/core/storage/model-config-store.js';

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
  readonly workspaces: PostgresWorkspaceStore;
  readonly modelConfig: PostgresModelConfigStore;
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
    this.workspaces = new PostgresWorkspaceStore(this);
    this.modelConfig = new PostgresModelConfigStore(this);
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

    await this.db.insert(this.t.sessions).values({
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
    });

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
    const rows = await this.db.select().from(this.t.sessions).where(eq(this.t.sessions.id, id)).limit(1);
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  async list(filter: SessionListFilter = {}): Promise<Session[]> {
    const conditions = [];

    if (filter.workspaceId === null) {
      conditions.push(isNull(this.t.sessions.workspaceId));
    } else if (filter.workspaceId !== undefined) {
      conditions.push(eq(this.t.sessions.workspaceId, filter.workspaceId));
    }

    conditions.push(eq(this.t.sessions.status, filter.status ?? 'active'));

    if (filter.pinned !== undefined) {
      conditions.push(eq(this.t.sessions.pinned, filter.pinned));
    }

    if (filter.query !== undefined && filter.query.trim() !== '') {
      conditions.push(like(this.t.sessions.title, `%${filter.query.trim()}%`));
    }

    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;

    const rows = await this.db
      .select()
      .from(this.t.sessions)
      .where(and(...conditions))
      .orderBy(desc(this.t.sessions.pinned), desc(this.t.sessions.updatedAt))
      .limit(limit)
      .offset(offset);

    return rows.map(mapSession);
  }

  async listRecent(limit: number): Promise<Session[]> {
    return this.list({ status: 'active', limit });
  }

  async touch(id: string): Promise<void> {
    await this.db.update(this.t.sessions)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(this.t.sessions.id, id));
  }

  async update(id: string, patch: SessionUpdate): Promise<Session | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;

    await this.db
      .update(this.t.sessions)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.titleIsCustom !== undefined ? { titleIsCustom: patch.titleIsCustom } : {}),
        ...(patch.workspaceId !== undefined ? { workspaceId: patch.workspaceId } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.model !== undefined ? { model: patch.model ?? '' } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(this.t.sessions.id, id));

    return this.get(id);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.update(id, { title });
  }

  async delete(id: string): Promise<void> {
    const t = this.t;
    const db = this.db;

    await db
      .delete(t.checkpointFiles)
      .where(inArray(
        t.checkpointFiles.checkpointId,
        db.select({ id: t.checkpoints.id }).from(t.checkpoints).where(eq(t.checkpoints.sessionId, id)),
      ));
    await db.delete(t.checkpoints).where(eq(t.checkpoints.sessionId, id));
    await db.delete(t.events).where(eq(t.events.sessionId, id));
    await db.update(t.memories).set({ sourceSessionId: null }).where(eq(t.memories.sourceSessionId, id));
    await db.delete(t.tasks).where(eq(t.tasks.sessionId, id));
    await db.delete(t.sessions).where(eq(t.sessions.id, id));
  }
}

function mapSession(row: {
  id: string; title: string; model: string; cwd: string; status: string; type: string;
  workspaceId: string | null; pinned: boolean; titleIsCustom: boolean; createdAt: string; updatedAt: string;
}): Session {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    cwd: row.cwd,
    status: row.status as Session['status'],
    type: row.type as Session['type'],
    workspaceId: row.workspaceId,
    pinned: row.pinned,
    titleIsCustom: row.titleIsCustom,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── WorkspaceStore ───

class PostgresWorkspaceStore implements WorkspaceStore {
  constructor(private readonly backend: PostgresBackend) {}

  private get t() { return this.backend.getTables(); }
  private get db() { return this.backend.getDb(); }

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

    await this.db.insert(this.t.workspaces).values({
      id,
      name: input.name,
      description,
      color,
      icon,
      sortOrder,
      createdAt: now,
      updatedAt: now,
    });

    return { id, name: input.name, description, color, icon, sortOrder, createdAt: now, updatedAt: now };
  }

  async get(id: string): Promise<Workspace | undefined> {
    const rows = await this.db.select().from(this.t.workspaces).where(eq(this.t.workspaces.id, id)).limit(1);
    return rows[0] ? mapWorkspace(rows[0]) : undefined;
  }

  async update(
    id: string,
    patch: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'sortOrder'>>,
  ): Promise<Workspace | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;

    await this.db
      .update(this.t.workspaces)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(this.t.workspaces.id, id));

    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    // sessions.workspace_id 通过 FK ON DELETE SET NULL 自动解绑为独立会话
    await this.db.delete(this.t.workspaces).where(eq(this.t.workspaces.id, id));
  }

  async list(): Promise<Workspace[]> {
    const t = this.t;
    const rows = await this.db
      .select({
        id: t.workspaces.id,
        name: t.workspaces.name,
        description: t.workspaces.description,
        color: t.workspaces.color,
        icon: t.workspaces.icon,
        sortOrder: t.workspaces.sortOrder,
        createdAt: t.workspaces.createdAt,
        updatedAt: t.workspaces.updatedAt,
        sessionCount: count(t.sessions.id),
      })
      .from(t.workspaces)
      .leftJoin(
        t.sessions,
        and(eq(t.sessions.workspaceId, t.workspaces.id), eq(t.sessions.status, 'active')),
      )
      .groupBy(
        t.workspaces.id,
        t.workspaces.name,
        t.workspaces.description,
        t.workspaces.color,
        t.workspaces.icon,
        t.workspaces.sortOrder,
        t.workspaces.createdAt,
        t.workspaces.updatedAt,
      )
      .orderBy(asc(t.workspaces.sortOrder), asc(t.workspaces.createdAt));

    return rows.map((r) => ({
      ...mapWorkspace(r),
      sessionCount: r.sessionCount,
    }));
  }
}

function mapWorkspace(row: {
  id: string; name: string; description: string; color: string | null; icon: string | null;
  sortOrder: number; createdAt: string; updatedAt: string;
}): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    sortOrder: row.sortOrder,
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

// ─── ModelConfigStore ───

interface ProviderRowLike {
  id: string;
  displayName: string;
  kind: string;
  baseURL: string | null;
  apiKeyCipher: string | null;
  apiKeyHint: string | null;
  apiKeyEnv: string | null;
  modelsJson: string;
  defaultContextWindow: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function mapProviderRow(row: ProviderRowLike): ProviderRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    kind: row.kind === 'anthropic' ? 'anthropic' : 'openai-compat',
    baseURL: row.baseURL ?? undefined,
    apiKeyCipher: row.apiKeyCipher ?? undefined,
    apiKeyHint: row.apiKeyHint ?? undefined,
    apiKeyEnv: row.apiKeyEnv ?? undefined,
    models: parseModelsJson(row.modelsJson),
    defaultContextWindow: row.defaultContextWindow ?? undefined,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const SETTINGS_ROW_ID = 'default';

class PostgresModelConfigStore implements ModelConfigStore {
  constructor(private readonly backend: PostgresBackend) {}

  private get db() {
    return this.backend.getDb();
  }

  private get t() {
    return this.backend.getTables();
  }

  async listProviders(): Promise<ProviderRecord[]> {
    const rows = await this.db
      .select()
      .from(this.t.modelProviders)
      .orderBy(asc(this.t.modelProviders.sortOrder), asc(this.t.modelProviders.createdAt));
    return rows.map(mapProviderRow);
  }

  async getProvider(id: string): Promise<ProviderRecord | undefined> {
    const rows = await this.db
      .select()
      .from(this.t.modelProviders)
      .where(eq(this.t.modelProviders.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? undefined : mapProviderRow(row);
  }

  async upsertProvider(input: ProviderRecordInput): Promise<ProviderRecord> {
    const existing = await this.getProvider(input.id);
    const now = new Date().toISOString();
    const values = {
      id: input.id,
      displayName: input.displayName,
      kind: input.kind,
      baseURL: input.baseURL ?? null,
      apiKeyCipher: input.apiKeyCipher ?? null,
      apiKeyHint: input.apiKeyHint ?? null,
      apiKeyEnv: input.apiKeyEnv ?? null,
      modelsJson: JSON.stringify(input.models),
      defaultContextWindow: input.defaultContextWindow ?? null,
      sortOrder: input.sortOrder,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.db
      .insert(this.t.modelProviders)
      .values(values)
      .onConflictDoUpdate({ target: this.t.modelProviders.id, set: values });

    const saved = await this.getProvider(input.id);
    if (saved === undefined) {
      throw new Error(`model provider "${input.id}" disappeared right after upsert`);
    }
    return saved;
  }

  async deleteProvider(id: string): Promise<void> {
    await this.db.delete(this.t.modelProviders).where(eq(this.t.modelProviders.id, id));
  }

  async getSettings(): Promise<ModelSelection | undefined> {
    const rows = await this.db
      .select()
      .from(this.t.modelSettings)
      .where(eq(this.t.modelSettings.id, SETTINGS_ROW_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    if (row.activeProviderId === null || row.activeModel === null) return undefined;
    return { providerId: row.activeProviderId, model: row.activeModel };
  }

  async saveSettings(selection: ModelSelection): Promise<void> {
    const values = {
      id: SETTINGS_ROW_ID,
      activeProviderId: selection.providerId,
      activeModel: selection.model,
      updatedAt: new Date().toISOString(),
    };
    await this.db
      .insert(this.t.modelSettings)
      .values(values)
      .onConflictDoUpdate({ target: this.t.modelSettings.id, set: values });
  }

  async clearSettings(): Promise<void> {
    await this.db.delete(this.t.modelSettings).where(eq(this.t.modelSettings.id, SETTINGS_ROW_ID));
  }
}

// ─── Factory ───

export function createPostgresBackend(config: PostgresConfig, schemaName: string): PostgresBackend {
  return new PostgresBackend(config, schemaName);
}
