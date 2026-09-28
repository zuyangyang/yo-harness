/**
 * SQLite UserStore 实现。
 */
import type { SqliteDatabase } from '@yo-harness/core/storage/db.js';
import { randomUUID } from 'node:crypto';

import type { User, CreateUserInput, UserRole } from '../auth/types.js';
import type { UserStore } from './user-store.js';

export class SqliteUserStore implements UserStore {
  constructor(private readonly db: SqliteDatabase) {}

  async create(input: CreateUserInput): Promise<User> {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO users (id, tenant_id, username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.tenantId, input.username, input.password, input.role, now, now);

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
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? mapUser(row) : undefined;
  }

  async findByUsername(tenantId: string, username: string): Promise<User | undefined> {
    const row = this.db.prepare('SELECT * FROM users WHERE tenant_id = ? AND username = ?')
      .get(tenantId, username) as UserRow | undefined;
    return row ? mapUser(row) : undefined;
  }

  async listByTenant(tenantId: string): Promise<User[]> {
    const rows = this.db.prepare('SELECT * FROM users WHERE tenant_id = ?')
      .all(tenantId) as UserRow[];
    return rows.map(mapUser);
  }

  async updateRole(id: string, role: UserRole): Promise<void> {
    this.db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
      .run(role, new Date().toISOString(), id);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}

interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role as User['role'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
