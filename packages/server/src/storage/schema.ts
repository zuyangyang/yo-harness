/**
 * Drizzle ORM schema 定义（PostgreSQL）。
 *
 * 使用 `pgSchema()` 动态创建 schema，支持 schema-per-tenant 隔离。
 * 表结构与 SQLite 版本一一对应。
 */
import {
  pgSchema,
  text,
  integer,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export function createTenantSchema(schemaName: string) {
  const schema = pgSchema(schemaName);

  const sessions = schema.table(
    'sessions',
    {
      id: text('id').primaryKey(),
      title: text('title').notNull().default(''),
      model: text('model').notNull(),
      cwd: text('cwd').notNull(),
      status: text('status').notNull().default('active'),
      type: text('type').notNull().default('interactive'),
      createdAt: text('created_at').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
  );

  const events = schema.table(
    'events',
    {
      id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
      sessionId: text('session_id').notNull().references(() => sessions.id),
      seq: integer('seq').notNull(),
      type: text('type').notNull(),
      payload: text('payload').notNull(),
      createdAt: text('created_at').notNull(),
    },
    (table) => [
      uniqueIndex('events_session_seq_idx').on(table.sessionId, table.seq),
      index('events_session_idx').on(table.sessionId, table.seq),
    ],
  );

  const checkpoints = schema.table(
    'checkpoints',
    {
      id: text('id').primaryKey(),
      sessionId: text('session_id').notNull().references(() => sessions.id),
      seq: integer('seq').notNull(),
      source: text('source').notNull(),
      createdAt: text('created_at').notNull(),
    },
    (table) => [
      index('checkpoints_session_idx').on(table.sessionId, table.seq),
    ],
  );

  const checkpointFiles = schema.table(
    'checkpoint_files',
    {
      id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
      checkpointId: text('checkpoint_id').notNull().references(() => checkpoints.id),
      relPath: text('rel_path').notNull(),
      content: text('content'),
    },
  );

  const memories = schema.table(
    'memories',
    {
      id: text('id').primaryKey(),
      title: text('title').notNull(),
      content: text('content').notNull(),
      category: text('category').notNull(),
      description: text('description').notNull(),
      keywords: text('keywords').notNull(),
      status: text('status').notNull().default('active'),
      sourceSessionId: text('source_session_id'),
      createdAt: text('created_at').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
    (table) => [
      index('memories_status_idx').on(table.status),
      index('memories_category_idx').on(table.category),
    ],
  );

  const tasks = schema.table(
    'tasks',
    {
      id: text('id').primaryKey(),
      description: text('description').notNull(),
      sessionId: text('session_id').notNull(),
      status: text('status').notNull().default('running'),
      pid: integer('pid'),
      cwd: text('cwd').notNull(),
      model: text('model').notNull(),
      createdAt: text('created_at').notNull(),
      completedAt: text('completed_at'),
      endReason: text('end_reason'),
      summary: text('summary'),
      errorMessage: text('error_message'),
    },
    (table) => [
      index('tasks_status_idx').on(table.status),
    ],
  );

  return {
    sessions,
    events,
    checkpoints,
    checkpointFiles,
    memories,
    tasks,
  };
}

export type TenantTables = ReturnType<typeof createTenantSchema>;
