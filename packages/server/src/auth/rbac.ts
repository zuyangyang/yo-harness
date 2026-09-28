/**
 * RBAC：基于角色的权限控制。
 *
 * 角色层级：admin > member > viewer
 * - admin：全部操作
 * - member：读写（不含管理操作）
 * - viewer：只读
 */
import type { Context, MiddlewareHandler } from 'hono';

import { getAuth, type AuthInfo } from './middleware.js';

export type Permission =
  | 'sessions:read'
  | 'sessions:write'
  | 'memories:read'
  | 'memories:write'
  | 'tasks:read'
  | 'tasks:write'
  | 'users:manage'
  | 'api_keys:manage'
  | 'admin';

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  viewer: ['sessions:read', 'memories:read', 'tasks:read'],
  member: [
    'sessions:read', 'sessions:write',
    'memories:read', 'memories:write',
    'tasks:read', 'tasks:write',
  ],
  admin: [
    'sessions:read', 'sessions:write',
    'memories:read', 'memories:write',
    'tasks:read', 'tasks:write',
    'users:manage', 'api_keys:manage',
    'admin',
  ],
};

export function hasPermission(auth: AuthInfo, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[auth.role] ?? [];
  return perms.includes(permission);
}

export function requirePermission(permission: Permission): MiddlewareHandler {
  return async (c, next) => {
    const auth = getAuth(c);
    if (!hasPermission(auth, permission)) {
      return c.json({ error: `forbidden: requires ${permission}` }, 403);
    }
    await next();
  };
}
