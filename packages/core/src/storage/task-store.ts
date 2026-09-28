/**
 * 后台任务存储：SQLite 实现。
 *
 * 端口为 async（为远程多租户存储预留），本实现内部同步、边界 async 化。
 * 任务与 session 一对一：每个任务创建时同步创建一条 background session，
 * 事件流写入 events 表（按 session_id 隔离），CLI 重放时走 EventStore.replay()。
 */
import { randomUUID } from 'node:crypto';

import type { SqliteDatabase } from './db.js';
import type { BackgroundTask, BackgroundTaskStatus, CreateTaskInput } from '../daemon/types.js';

interface TaskRow {
  id: string;
  description: string;
  session_id: string;
  status: string;
  pid: number | null;
  cwd: string;
  model: string;
  created_at: string;
  completed_at: string | null;
  end_reason: string | null;
  summary: string | null;
  error_message: string | null;
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<BackgroundTask>;
  get(id: string): Promise<BackgroundTask | undefined>;
  list(limit?: number): Promise<BackgroundTask[]>;
  updateStatus(
    id: string,
    status: BackgroundTaskStatus,
    endReason?: BackgroundTask['endReason'],
    errorMessage?: string,
    summary?: string,
  ): Promise<void>;
}

function mapTask(row: TaskRow): BackgroundTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    description: row.description,
    status: row.status as BackgroundTaskStatus,
    pid: row.pid,
    endReason: row.end_reason as BackgroundTask['endReason'],
    completedAt: row.completed_at,
    summary: row.summary,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    cwd: row.cwd,
    model: row.model,
  };
}

export class SqliteTaskStore implements TaskStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: CreateTaskInput): Promise<BackgroundTask> {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date().toISOString();

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, title, model, cwd, status, type, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 'background', ?, ?)`,
        )
        .run(sessionId, input.description.slice(0, 60), input.model, input.cwd, now, now);

      this.db
        .prepare(
          `INSERT INTO tasks (id, description, session_id, status, cwd, model, created_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(taskId, input.description, sessionId, input.cwd, input.model, now);
    });
    insert();

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
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  async list(limit = 50): Promise<BackgroundTask[]> {
    const rows = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
      .all(limit) as TaskRow[];
    return rows.map(mapTask);
  }

  async updateStatus(
    id: string,
    status: BackgroundTaskStatus,
    endReason?: BackgroundTask['endReason'],
    errorMessage?: string,
    summary?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const completedAt = ['completed', 'failed', 'cancelled'].includes(status) ? now : null;

    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, end_reason = ?, completed_at = ?, error_message = ?, summary = ?
         WHERE id = ?`,
      )
      .run(status, endReason ?? null, completedAt, errorMessage ?? null, summary ?? null, id);
  }
}
