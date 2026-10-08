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
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export function createTenantSchema(schemaName: string) {
  const schema = pgSchema(schemaName);

  const workspaces = schema.table(
    'workspaces',
    {
      id: text('id').primaryKey(),
      name: text('name').notNull(),
      description: text('description').notNull().default(''),
      color: text('color'),
      icon: text('icon'),
      sortOrder: integer('sort_order').notNull().default(0),
      createdAt: text('created_at').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
    (table) => [
      index('workspaces_sort_idx').on(table.sortOrder, table.createdAt),
    ],
  );

  const sessions = schema.table(
    'sessions',
    {
      id: text('id').primaryKey(),
      title: text('title').notNull().default(''),
      model: text('model').notNull(),
      cwd: text('cwd').notNull(),
      status: text('status').notNull().default('active'),
      type: text('type').notNull().default('interactive'),
      workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
      pinned: boolean('pinned').notNull().default(false),
      titleIsCustom: boolean('title_is_custom').notNull().default(false),
      permissionMode: text('permission_mode'),
      createdAt: text('created_at').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
    (table) => [
      index('sessions_workspace_idx').on(table.workspaceId, table.updatedAt),
      index('sessions_status_idx').on(table.status, table.updatedAt),
    ],
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

  const users = schema.table(
    'users',
    {
      id: text('id').primaryKey(),
      tenantId: text('tenant_id').notNull(),
      username: text('username').notNull(),
      passwordHash: text('password_hash').notNull(),
      role: text('role').notNull().default('member'),
      createdAt: text('created_at').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
    (table) => [
      uniqueIndex('users_tenant_username_idx').on(table.tenantId, table.username),
    ],
  );

  const apiKeys = schema.table(
    'api_keys',
    {
      id: text('id').primaryKey(),
      tenantId: text('tenant_id').notNull(),
      userId: text('user_id').notNull(),
      name: text('name').notNull(),
      keyHash: text('key_hash').notNull(),
      role: text('role').notNull(),
      createdAt: text('created_at').notNull(),
      lastUsedAt: text('last_used_at'),
    },
    (table) => [
      index('api_keys_user_idx').on(table.userId),
    ],
  );

  const modelProviders = schema.table(
    'model_providers',
    {
      id: text('id').primaryKey(),
      displayName: text('display_name').notNull(),
      kind: text('kind').notNull(),
      baseURL: text('base_url'),
      apiKeyCipher: text('api_key_cipher'),
      apiKeyHint: text('api_key_hint'),
      apiKeyEnv: text('api_key_env'),
      modelsJson: text('models_json').notNull().default('[]'),
      defaultContextWindow: integer('default_context_window'),
      sortOrder: integer('sort_order').notNull().default(0),
      createdAt: text('created_at').notNull(),
      updatedAt: text('updated_at').notNull(),
    },
    (table) => [
      index('model_providers_sort_idx').on(table.sortOrder, table.createdAt),
    ],
  );

  const modelSettings = schema.table('model_settings', {
    id: text('id').primaryKey(),
    activeProviderId: text('active_provider_id'),
    activeModel: text('active_model'),
    updatedAt: text('updated_at').notNull(),
  });

  return {
    workspaces,
    modelProviders,
    modelSettings,
    sessions,
    events,
    checkpoints,
    checkpointFiles,
    memories,
    tasks,
    users,
    apiKeys,
  };
}

export type TenantTables = ReturnType<typeof createTenantSchema>;
