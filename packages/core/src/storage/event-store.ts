/**
 * 事件存储：append-only，seq 在事务内单调分配。
 * 重放时对 payload 重新做 schema 校验，损坏数据立即暴露而非静默吞掉。
 */
import type { AgentEvent, EventEnvelope } from '../types/events.js';
import { AgentEventSchema } from '../types/events.js';
import { FatalError } from '../types/errors.js';
import type { EventStore } from '../core/ports.js';
import type { SqliteDatabase } from './db.js';

interface EventRow {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  created_at: string;
}

export class SqliteEventStore implements EventStore {
  constructor(private readonly db: SqliteDatabase) {}

  async append(sessionId: string, event: AgentEvent): Promise<EventEnvelope> {
    // 边界校验 + 规范化（strip 未知字段）
    const payload = AgentEventSchema.parse(event);
    const ts = new Date().toISOString();

    const insert = this.db.transaction((): EventEnvelope => {
      const last = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?')
        .get(sessionId) as { seq: number };
      const seq = last.seq + 1;
      const info = this.db
        .prepare(
          'INSERT INTO events (session_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(sessionId, seq, payload.type, JSON.stringify(payload), ts);
      return { id: Number(info.lastInsertRowid), sessionId, seq, ts, payload };
    });

    return insert();
  }

  async replay(sessionId: string): Promise<EventEnvelope[]> {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as unknown as EventRow[];
    return rows.map(envelopeOf);
  }

  async lastSeq(sessionId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?')
      .get(sessionId) as { seq: number };
    return row.seq;
  }

  async deleteFrom(sessionId: string, fromSeq: number): Promise<number> {
    const info = this.db
      .prepare('DELETE FROM events WHERE session_id = ? AND seq >= ?')
      .run(sessionId, fromSeq);
    return info.changes;
  }
}

function envelopeOf(row: EventRow): EventEnvelope {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    ts: row.created_at,
    payload: parsePayload(row),
  };
}

function parsePayload(row: EventRow): AgentEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload);
  } catch {
    throw new FatalError(`corrupt event payload at id=${row.id}`);
  }
  const parsed = AgentEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FatalError(
      `event payload failed schema validation at id=${row.id}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
