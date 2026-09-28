/**
 * PostgreSQL UserStore 实现。
 */
import { eq, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';

import type { User, CreateUserInput, UserRole } from '../auth/types.js';
import type { TenantTables } from './schema.js';

export interface UserStore {
  create(input: CreateUserInput): Promise<User>;
  get(id: string): Promise<User | undefined>;
  findByUsername(tenantId: string, username: string): Promise<User | undefined>;
  listByTenant(tenantId: string): Promise<User[]>;
  updateRole(id: string, role: UserRole): Promise<void>;
  delete(id: string): Promise<void>;
}

export class PostgresUserStore implements UserStore {
  constructor(
    private readonly db: NodePgDatabase<Record<string, never>>,
    private readonly tables: TenantTables,
  ) {}

  async create(input: CreateUserInput): Promise<User> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.db.insert(this.tables.users).values({
      id,
      tenantId: input.tenantId,
      username: input.username,
      passwordHash: input.password,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    });

    return {
      id,
      tenantId: input.tenantId,
      username: input.username,
      passwordHash: input.password,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(id: string): Promise<User | undefined> {
    const rows = await this.db.select().from(this.tables.users)
      .where(eq(this.tables.users.id, id))
      .limit(1);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async findByUsername(tenantId: string, username: string): Promise<User | undefined> {
    const rows = await this.db.select().from(this.tables.users)
      .where(and(
        eq(this.tables.users.tenantId, tenantId),
        eq(this.tables.users.username, username),
      ))
      .limit(1);
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async listByTenant(tenantId: string): Promise<User[]> {
    const rows = await this.db.select().from(this.tables.users)
      .where(eq(this.tables.users.tenantId, tenantId));
    return rows.map(mapUser);
  }

  async updateRole(id: string, role: UserRole): Promise<void> {
    await this.db.update(this.tables.users)
      .set({ role, updatedAt: new Date().toISOString() })
      .where(eq(this.tables.users.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(this.tables.users)
      .where(eq(this.tables.users.id, id));
  }
}

function mapUser(row: {
  id: string; tenantId: string; username: string;
  passwordHash: string; role: string; createdAt: string; updatedAt: string;
}): User {
  return {
    id: row.id,
    tenantId: row.tenantId,
    username: row.username,
    passwordHash: row.passwordHash,
    role: row.role as User['role'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
