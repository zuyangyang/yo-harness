/**
 * 鉴权相关类型定义。
 */

export type UserRole = 'admin' | 'member' | 'viewer';

export interface User {
  id: string;
  tenantId: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  tenantId: string;
  username: string;
  password: string;
  role: UserRole;
}

export interface ApiKey {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  keyHash: string;
  role: UserRole;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CreateApiKeyInput {
  tenantId: string;
  userId: string;
  name: string;
  role: UserRole;
}
