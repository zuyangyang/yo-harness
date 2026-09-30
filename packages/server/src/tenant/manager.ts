/**
 * TenantManager：管理租户生命周期。
 *
 * 租户元数据存储在 public schema 的 tenants 表中，
 * 每个租户的数据存储在独立的 `tenant_<id>` schema 中。
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

import type { PostgresConfig } from '../storage/postgres.js';
import { PostgresBackend } from '../storage/postgres.js';
import { tenantSchemaName } from './context.js';

export interface Tenant {
  id: string;
  name: string;
  schemaName: string;
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantInput {
  name: string;
}

export class TenantManager {
  private readonly pool: Pool;
  private readonly backends = new Map<string, PostgresBackend>();

  constructor(private readonly config: PostgresConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        schema_name TEXT NOT NULL UNIQUE,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `);
  }

  async create(input: CreateTenantInput): Promise<Tenant> {
    const id = randomUUID();
    const schemaName = tenantSchemaName(id);
    const now = new Date().toISOString();

    await this.pool.query(
      `INSERT INTO tenants (id, name, schema_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, $5)`,
      [id, input.name, schemaName, now, now],
    );

    const backend = new PostgresBackend(this.config, schemaName);
    await backend.initialize();
    this.backends.set(id, backend);

    return { id, name: input.name, schemaName, status: 'active', createdAt: now, updatedAt: now };
  }

  async get(id: string): Promise<Tenant | undefined> {
    const result = await this.pool.query<TenantRow>(
      'SELECT * FROM tenants WHERE id = $1',
      [id],
    );
    return result.rows[0] ? mapTenant(result.rows[0]) : undefined;
  }

  async list(): Promise<Tenant[]> {
    const result = await this.pool.query('SELECT * FROM tenants ORDER BY created_at');
    return result.rows.map(mapTenant);
  }

  async suspend(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE tenants SET status = 'suspended', updated_at = $1 WHERE id = $2`,
      [new Date().toISOString(), id],
    );
    this.backends.delete(id);
  }

  async activate(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE tenants SET status = 'active', updated_at = $1 WHERE id = $2`,
      [new Date().toISOString(), id],
    );
  }

  async delete(id: string): Promise<void> {
    const tenant = await this.get(id);
    if (!tenant) return;

    this.backends.delete(id);

    await this.pool.query(`DROP SCHEMA IF EXISTS "${tenant.schemaName}" CASCADE`);
    await this.pool.query('DELETE FROM tenants WHERE id = $1', [id]);
  }

  async getBackend(tenantId: string): Promise<PostgresBackend> {
    const cached = this.backends.get(tenantId);
    if (cached) return cached;

    const tenant = await this.get(tenantId);
    if (!tenant) throw new Error(`tenant not found: ${tenantId}`);
    if (tenant.status !== 'active') throw new Error(`tenant suspended: ${tenantId}`);

    const backend = new PostgresBackend(this.config, tenant.schemaName);
    await backend.initialize();
    this.backends.set(tenantId, backend);
    return backend;
  }

  async close(): Promise<void> {
    for (const backend of this.backends.values()) {
      await backend.close();
    }
    this.backends.clear();
    await this.pool.end();
  }
}

interface TenantRow {
  id: string; name: string; schema_name: string;
  status: string; created_at: string; updated_at: string;
}

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    schemaName: row.schema_name,
    status: row.status as Tenant['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
