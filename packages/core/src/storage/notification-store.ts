/**
 * 站内通知存储：SQLite 实现。
 */
import { randomUUID } from 'node:crypto';

import type { SqliteDatabase } from './db.js';
import type { Notification, NotificationStore } from '../core/ports.js';

interface NotificationRow {
  id: string;
  session_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
}

function mapNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export class SqliteNotificationStore implements NotificationStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: {
    sessionId: string | null;
    kind: string;
    title: string;
    body: string | null;
  }): Promise<Notification> {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO notifications (id, session_id, kind, title, body, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, input.sessionId, input.kind, input.title, input.body, now);

    return {
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      readAt: null,
      createdAt: now,
    };
  }

  async list(limit = 50): Promise<Notification[]> {
    const rows = this.db
      .prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?')
      .all(limit) as NotificationRow[];
    return rows.map(mapNotification);
  }

  async markRead(id: string): Promise<void> {
    this.db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  async markAllRead(): Promise<void> {
    this.db
      .prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL')
      .run(new Date().toISOString());
  }

  async countUnread(): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL')
      .get() as { n: number };
    return row.n;
  }
}
