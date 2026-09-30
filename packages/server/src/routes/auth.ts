/**
 * 鉴权相关路由：注册 / 登录 / 刷新 / API Key 管理。
 */
import { Hono } from 'hono';

import type { StorageBackend } from '../storage/interface.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  type JwtConfig,
} from '../auth/jwt.js';
import { authMiddleware, getAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/rbac.js';
import type { UserRole } from '../auth/types.js';

export interface AuthRouteDeps {
  storage: StorageBackend;
  jwtConfig: JwtConfig;
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono {
  const app = new Hono();
  const { storage, jwtConfig } = deps;

  // ─── 注册 ───
  app.post('/register', async (c) => {
    const body = await c.req.json<{
      tenantId: string;
      username: string;
      password: string;
      role?: UserRole;
    }>();

    if (!body.tenantId || !body.username || !body.password) {
      return c.json({ error: 'tenantId, username, password are required' }, 400);
    }

    const existing = await storage.users.findByUsername(body.tenantId, body.username);
    if (existing) {
      return c.json({ error: 'username already exists in this tenant' }, 409);
    }

    const passwordHash = await hashPassword(body.password);
    const user = await storage.users.create({
      tenantId: body.tenantId,
      username: body.username,
      password: passwordHash,
      role: body.role ?? 'member',
    });

    const tokenPayload = { userId: user.id, tenantId: user.tenantId, role: user.role };
    const accessToken = await signAccessToken(tokenPayload, jwtConfig);
    const refreshToken = await signRefreshToken({ userId: user.id, tenantId: user.tenantId }, jwtConfig);

    return c.json({
      accessToken,
      refreshToken,
      user: { id: user.id, username: user.username, role: user.role },
    }, 201);
  });

  // ─── 登录 ───
  app.post('/login', async (c) => {
    const body = await c.req.json<{
      tenantId: string;
      username: string;
      password: string;
    }>();

    if (!body.tenantId || !body.username || !body.password) {
      return c.json({ error: 'tenantId, username, password are required' }, 400);
    }

    const user = await storage.users.findByUsername(body.tenantId, body.username);
    if (!user) {
      return c.json({ error: 'invalid credentials' }, 401);
    }

    const valid = await verifyPassword(user.passwordHash, body.password);
    if (!valid) {
      return c.json({ error: 'invalid credentials' }, 401);
    }

    const tokenPayload = { userId: user.id, tenantId: user.tenantId, role: user.role };
    const accessToken = await signAccessToken(tokenPayload, jwtConfig);
    const refreshToken = await signRefreshToken({ userId: user.id, tenantId: user.tenantId }, jwtConfig);

    return c.json({ accessToken, refreshToken, user: { id: user.id, username: user.username, role: user.role } });
  });

  // ─── 刷新 access token ───
  app.post('/refresh', async (c) => {
    const body = await c.req.json<{ refreshToken: string }>();
    if (!body.refreshToken) {
      return c.json({ error: 'refreshToken is required' }, 400);
    }

    try {
      const payload = await verifyToken(body.refreshToken, jwtConfig);
      if (payload.role !== 'refresh') {
        return c.json({ error: 'not a refresh token' }, 400);
      }

      const user = await storage.users.get(payload.userId);
      if (!user) {
        return c.json({ error: 'user not found' }, 401);
      }

      const tokenPayload = { userId: user.id, tenantId: user.tenantId, role: user.role };
      const accessToken = await signAccessToken(tokenPayload, jwtConfig);
      return c.json({ accessToken });
    } catch {
      return c.json({ error: 'invalid or expired refresh token' }, 401);
    }
  });

  // ─── 以下路由需要鉴权 ───
  app.use('/me', authMiddleware({ storage, jwtConfig }));
  app.use('/api-keys/*', authMiddleware({ storage, jwtConfig }));

  // ─── 当前用户信息 ───
  app.get('/me', authMiddleware({ storage, jwtConfig }), async (c) => {
    const auth = getAuth(c);
    const user = await storage.users.get(auth.userId);
    if (!user) {
      return c.json({ error: 'user not found' }, 404);
    }
    return c.json({ user: { id: user.id, username: user.username, role: user.role } });
  });

  // ─── 创建 API Key ───
  app.post('/api-keys', requirePermission('api_keys:manage'), async (c) => {
    const auth = getAuth(c);
    const body = await c.req.json<{ name: string; role?: UserRole }>();

    if (!body.name) {
      return c.json({ error: 'name is required' }, 400);
    }

    const { apiKey, rawKey } = await storage.apiKeys.create({
      tenantId: auth.tenantId,
      userId: auth.userId,
      name: body.name,
      role: body.role ?? auth.role,
    });

    return c.json({
      id: apiKey.id,
      name: apiKey.name,
      role: apiKey.role,
      key: rawKey,
      createdAt: apiKey.createdAt,
    }, 201);
  });

  // ─── 列出 API Keys ───
  app.get('/api-keys', async (c) => {
    const auth = getAuth(c);
    const keys = await storage.apiKeys.listByUser(auth.userId);

    return c.json(keys.map((k) => ({
      id: k.id,
      name: k.name,
      role: k.role,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    })));
  });

  // ─── 撤销 API Key ───
  app.delete('/api-keys/:id', requirePermission('api_keys:manage'), async (c) => {
    const auth = getAuth(c);
    const id = c.req.param('id');

    const key = await storage.apiKeys.get(id);
    if (key?.userId !== auth.userId) {
      return c.json({ error: 'API key not found' }, 404);
    }

    await storage.apiKeys.revoke(id);
    return c.json({ ok: true });
  });

  return app;
}
