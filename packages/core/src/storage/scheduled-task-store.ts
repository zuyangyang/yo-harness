/**
 * 定时任务存储：SQLite 实现。
 *
 * 端口为 async（为远程多租户存储预留），本实现内部同步、边界 async 化。
 * 表结构见 db.ts v8 迁移；server 的 Postgres 后端有对应实现。
 */
import { randomUUID } from 'node:crypto';

import type { SqliteDatabase } from './db.js';
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskStore,
  ScheduleCatchUpPolicy,
  ScheduleOutputKind,
  ScheduleOverlapPolicy,
} from '../core/ports.js';

interface ScheduledTaskRow {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: number;
  workspace_id: string | null;
  cwd: string | null;
  model: string | null;
  permission_mode: string;
  allowed_tools: string | null;
  max_steps: number | null;
  max_tokens: number | null;
  max_duration_ms: number | null;
  output_kind: string;
  output_target: string | null;
  overlap_policy: string;
  catch_up_policy: string;
  next_run_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
  last_status: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

function parseAllowedTools(raw: string | null): string[] | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function mapScheduledTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled !== 0,
    workspaceId: row.workspace_id,
    cwd: row.cwd,
    model: row.model,
    permissionMode: 'full',
    allowedTools: parseAllowedTools(row.allowed_tools),
    maxSteps: row.max_steps,
    maxTokens: row.max_tokens,
    maxDurationMs: row.max_duration_ms,
    outputKind: row.output_kind as ScheduleOutputKind,
    outputTarget: row.output_target,
    overlapPolicy: row.overlap_policy as ScheduleOverlapPolicy,
    catchUpPolicy: row.catch_up_policy as ScheduleCatchUpPolicy,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    lastStatus: row.last_status,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMN_BY_FIELD: Record<string, string> = {
  name: 'name',
  prompt: 'prompt',
  cron: 'cron',
  timezone: 'timezone',
  enabled: 'enabled',
  workspaceId: 'workspace_id',
  cwd: 'cwd',
  model: 'model',
  allowedTools: 'allowed_tools',
  maxSteps: 'max_steps',
  maxTokens: 'max_tokens',
  maxDurationMs: 'max_duration_ms',
  outputKind: 'output_kind',
  outputTarget: 'output_target',
  overlapPolicy: 'overlap_policy',
  catchUpPolicy: 'catch_up_policy',
  nextRunAt: 'next_run_at',
  lastRunAt: 'last_run_at',
  lastRunId: 'last_run_id',
  lastStatus: 'last_status',
  consecutiveFailures: 'consecutive_failures',
};

function toColumnValue(field: string, value: unknown): string | number | null {
  if (field === 'enabled') return value ? 1 : 0;
  if (field === 'allowedTools') return value === null ? null : JSON.stringify(value);
  return value as string | number | null;
}

export class SqliteScheduledTaskStore implements ScheduledTaskStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: ScheduledTaskCreateInput): Promise<ScheduledTask> {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (
           id, name, prompt, cron, timezone, enabled, workspace_id, cwd, model,
           permission_mode, allowed_tools, max_steps, max_tokens, max_duration_ms,
           output_kind, output_target, overlap_policy, catch_up_policy,
           next_run_at, consecutive_failures, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'full', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.prompt,
        input.cron,
        input.timezone ?? 'UTC',
        input.enabled === false ? 0 : 1,
        input.workspaceId ?? null,
        input.cwd ?? null,
        input.model ?? null,
        input.allowedTools === undefined || input.allowedTools === null
          ? null
          : JSON.stringify(input.allowedTools),
        input.maxSteps ?? null,
        input.maxTokens ?? null,
        input.maxDurationMs ?? null,
        input.outputKind ?? 'report',
        input.outputTarget ?? null,
        input.overlapPolicy ?? 'skip',
        input.catchUpPolicy ?? 'skip',
        input.nextRunAt,
        now,
        now,
      );

    const created = await this.get(id);
    if (created === undefined) throw new Error('failed to create scheduled task');
    return created;
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    const row = this.db
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
      .get(id) as ScheduledTaskRow | undefined;
    return row === undefined ? undefined : mapScheduledTask(row);
  }

  async list(): Promise<ScheduledTask[]> {
    const rows = this.db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
      .all() as ScheduledTaskRow[];
    return rows.map(mapScheduledTask);
  }

  async update(
    id: string,
    patch: Partial<ScheduledTask>,
  ): Promise<ScheduledTask | undefined> {
    const existing = await this.get(id);
    if (existing === undefined) return undefined;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const column = COLUMN_BY_FIELD[field];
      if (column === undefined || value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(toColumnValue(field, value));
    }
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  }

  async listDue(at: string): Promise<ScheduledTask[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC',
      )
      .all(at) as ScheduledTaskRow[];
    return rows.map(mapScheduledTask);
  }
}
