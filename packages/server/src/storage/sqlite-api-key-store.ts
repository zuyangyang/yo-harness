/**
 * SQLite ApiKeyStore 实现。
 */
import type { SqliteDatabase } from '@yo-harness/core/storage/db.js';
import { randomUUID, randomBytes } from 'node:crypto';

import type { ApiKey, CreateApiKeyInput, UserRole } from '../auth/types.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { ApiKeyStore } from './api-key-store.js';

export class SqliteApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: CreateApiKeyInput): Promise<{ apiKey: ApiKey; rawKey: string }> {
    const id = randomUUID();
    const rawKey = `yoh_${randomBytes(48).toString('hex')}`;
    const keyHash = await hashPassword(rawKey);
    const now = new Date().toISOString();

    const apiKey: ApiKey = {
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      name: input.name,
      keyHash,
      role: input.role,
      createdAt: now,
      lastUsedAt: null,
    };

    this.db.prepare(`
      INSERT INTO api_keys (id, tenant_id, user_id, name, key_hash, role, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(id, input.tenantId, input.userId, input.name, keyHash, input.role, now);

    return { apiKey, rawKey };
  }

  async get(id: string): Promise<ApiKey | undefined> {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
    return row ? mapApiKey(row) : undefined;
  }

  async listByUser(userId: string): Promise<ApiKey[]> {
    const rows = this.db.prepare('SELECT * FROM api_keys WHERE user_id = ?')
      .all(userId) as ApiKeyRow[];
    return rows.map(mapApiKey);
  }

  async revoke(id: string): Promise<void> {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
  }

  async verifyByKey(rawKey: string): Promise<ApiKey | null> {
    const rows = this.db.prepare('SELECT * FROM api_keys').all() as ApiKeyRow[];
    for (const row of rows) {
      const matched = await verifyPassword(row.key_hash, rawKey);
      if (matched) {
        this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
          .run(new Date().toISOString(), row.id);
        return mapApiKey(row);
      }
    }
    return null;
  }
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  key_hash: string;
  role: string;
  created_at: string;
  last_used_at: string | null;
}

function mapApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    name: row.name,
    keyHash: row.key_hash,
    role: row.role as UserRole,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
