/**
 * 检查点持久化（SQLite 实现）。
 *
 * 两张表：checkpoints（元数据）+ checkpoint_files（文件快照 BLOB）。
 * 所有写操作包在事务里，保证检查点 + 文件快照的原子性。
 */
import { randomUUID } from 'node:crypto';

import type { SqliteDatabase } from './db.js';
import type {
  CheckpointDetail,
  CheckpointFileInfo,
  CheckpointStore,
  CheckpointSummary,
} from '../core/ports.js';

export class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: {
    sessionId: string;
    seq: number;
    source: 'auto_write' | 'auto_undo' | 'manual';
    files: CheckpointFileInfo[];
  }): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO checkpoints (id, session_id, seq, source, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, input.sessionId, input.seq, input.source, now);

      const insertFile = this.db.prepare(
        'INSERT INTO checkpoint_files (checkpoint_id, rel_path, content) VALUES (?, ?, ?)',
      );
      for (const file of input.files) {
        insertFile.run(id, file.relPath, file.content);
      }
    });
    txn();
    return id;
  }

  async get(checkpointId: string): Promise<CheckpointDetail | undefined> {
    const row = this.db
      .prepare('SELECT id, source, created_at FROM checkpoints WHERE id = ?')
      .get(checkpointId) as { id: string; source: string; created_at: string } | undefined;

    if (row === undefined) return undefined;

    const files = this.db
      .prepare(
        'SELECT rel_path, CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END AS has_content FROM checkpoint_files WHERE checkpoint_id = ? ORDER BY rel_path',
      )
      .all(checkpointId) as { rel_path: string; has_content: number }[];

    return {
      id: row.id,
      source: row.source,
      createdAt: row.created_at,
      files: files.map((f) => ({ relPath: f.rel_path, hasContent: f.has_content === 1 })),
    };
  }

  async listBySession(sessionId: string): Promise<CheckpointSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.seq, c.source, c.created_at, COUNT(cf.id) AS file_count
         FROM checkpoints c
         LEFT JOIN checkpoint_files cf ON cf.checkpoint_id = c.id
         WHERE c.session_id = ?
         GROUP BY c.id
         ORDER BY c.seq ASC`,
      )
      .all(sessionId) as {
      id: string;
      seq: number;
      source: string;
      created_at: string;
      file_count: number;
    }[];

    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      source: r.source,
      createdAt: r.created_at,
      fileCount: r.file_count,
    }));
  }

  async readFileContent(checkpointId: string, relPath: string): Promise<Buffer | null> {
    const row = this.db
      .prepare('SELECT content FROM checkpoint_files WHERE checkpoint_id = ? AND rel_path = ?')
      .get(checkpointId, relPath) as { content: Buffer | null } | undefined;

    return row?.content ?? null;
  }

  async getAdjacent(
    sessionId: string,
    currentSeq: number,
    direction: 'prev' | 'next',
  ): Promise<{ id: string; seq: number } | undefined> {
    const cmp = direction === 'prev' ? '<' : '>';
    const order = direction === 'prev' ? 'DESC' : 'ASC';

    const row = this.db
      .prepare(
        `SELECT id, seq FROM checkpoints WHERE session_id = ? AND seq ${cmp} ? ORDER BY seq ${order} LIMIT 1`,
      )
      .get(sessionId, currentSeq) as { id: string; seq: number } | undefined;

    return row;
  }
}
