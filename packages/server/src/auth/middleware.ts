/**
 * Hono 鉴权中间件：从 Bearer token 解析用户身份。
 *
 * 支持两种认证方式：
 * - JWT access token（`yoh_` 前缀以外的任意 token）
 * - API Key（`yoh_` 前缀）
 *
 * 成功后将用户信息写入 `c.set('auth', ...)`，下游通过 `getAuth(c)` 获取。
 */
import type { Context, MiddlewareHandler } from 'hono';

import type { StorageBackend } from '../storage/interface.js';
import { verifyToken, type JwtConfig } from './jwt.js';
import type { UserRole } from './types.js';

export interface AuthInfo {
  userId: string;
  tenantId: string;
  role: UserRole;
}

const AUTH_KEY = 'auth';

export function getAuth(c: Context): AuthInfo {
  const auth = c.get(AUTH_KEY);
  if (!auth) throw new Error('auth middleware not applied on this route');
  return auth as AuthInfo;
}

export interface AuthMiddlewareDeps {
  storage: StorageBackend;
  jwtConfig: JwtConfig;
}

export function authMiddleware(deps: AuthMiddlewareDeps): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'missing or invalid Authorization header' }, 401);
    }

    const token = header.slice(7);

    if (token.startsWith('yoh_')) {
      const apiKey = await deps.storage.apiKeys.verifyByKey(token);
      if (!apiKey) {
        return c.json({ error: 'invalid API key' }, 401);
      }
      c.set(AUTH_KEY, {
        userId: apiKey.userId,
        tenantId: apiKey.tenantId,
        role: apiKey.role,
      } satisfies AuthInfo);
    } else {
      try {
        const payload = await verifyToken(token, deps.jwtConfig);
        if (payload.role === 'refresh') {
          return c.json({ error: 'refresh token cannot be used for API access' }, 401);
        }
        c.set(AUTH_KEY, {
          userId: payload.userId,
          tenantId: payload.tenantId,
          role: payload.role as UserRole,
        } satisfies AuthInfo);
      } catch {
        return c.json({ error: 'invalid or expired token' }, 401);
      }
    }

    await next();
  };
}
