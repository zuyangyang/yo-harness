/**
 * PostgreSQL ApiKeyStore 实现。
 *
 * API Key 格式：`yoh_<48 字节 hex>`，存储时仅保存 argon2id 哈希。
 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID, randomBytes } from 'node:crypto';

import type { ApiKey, CreateApiKeyInput, UserRole } from '../auth/types.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { TenantTables } from './schema.js';

export interface ApiKeyStore {
  create(input: CreateApiKeyInput): Promise<{ apiKey: ApiKey; rawKey: string }>;
  get(id: string): Promise<ApiKey | undefined>;
  listByUser(userId: string): Promise<ApiKey[]>;
  revoke(id: string): Promise<void>;
  verifyByKey(rawKey: string): Promise<ApiKey | null>;
}

export class PostgresApiKeyStore implements ApiKeyStore {
  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    private readonly tables: TenantTables,
  ) {}

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

    await this.db.insert(this.tables.apiKeys).values({
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      name: input.name,
      keyHash,
      role: input.role,
      createdAt: now,
      lastUsedAt: null,
    });

    return { apiKey, rawKey };
  }

  async get(id: string): Promise<ApiKey | undefined> {
    const rows = await this.db.select().from(this.tables.apiKeys)
      .where(eq(this.tables.apiKeys.id, id))
      .limit(1);
    return rows[0] ? mapApiKey(rows[0]) : undefined;
  }

  async listByUser(userId: string): Promise<ApiKey[]> {
    const rows = await this.db.select().from(this.tables.apiKeys)
      .where(eq(this.tables.apiKeys.userId, userId));
    return rows.map(mapApiKey);
  }

  async revoke(id: string): Promise<void> {
    await this.db.delete(this.tables.apiKeys)
      .where(eq(this.tables.apiKeys.id, id));
  }

  async verifyByKey(rawKey: string): Promise<ApiKey | null> {
    const rows = await this.db.select().from(this.tables.apiKeys);
    for (const row of rows) {
      const matched = await verifyPassword(row.keyHash, rawKey);
      if (matched) {
        await this.db.update(this.tables.apiKeys)
          .set({ lastUsedAt: new Date().toISOString() })
          .where(eq(this.tables.apiKeys.id, row.id));
        return mapApiKey(row);
      }
    }
    return null;
  }
}

function mapApiKey(row: {
  id: string; tenantId: string; userId: string; name: string;
  keyHash: string; role: string; createdAt: string; lastUsedAt: string | null;
}): ApiKey {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    name: row.name,
    keyHash: row.keyHash,
    role: row.role as UserRole,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
