/**
 * 管理路由：租户 CRUD + 成员管理。
 *
 * 所有路由需要 admin 角色。
 */
import { Hono } from 'hono';

import type { StorageBackend } from '../storage/interface.js';
import { authMiddleware, getAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/rbac.js';
import { hashPassword } from '../auth/password.js';
import type { JwtConfig } from '../auth/jwt.js';
import type { UserRole } from '../auth/types.js';
import type { TenantManager } from '../tenant/manager.js';

export interface AdminRouteDeps {
  storage: StorageBackend;
  jwtConfig: JwtConfig;
  tenantManager: TenantManager;
}

export function createAdminRoutes(deps: AdminRouteDeps): Hono {
  const app = new Hono();
  const { storage, jwtConfig, tenantManager } = deps;

  app.use('*', authMiddleware({ storage, jwtConfig }));
  app.use('*', requirePermission('admin'));

  // ─── 租户管理 ───

  app.post('/tenants', async (c) => {
    const body = await c.req.json<{ name: string }>();
    if (!body.name) {
      return c.json({ error: 'name is required' }, 400);
    }
    const tenant = await tenantManager.create({ name: body.name });
    return c.json(tenant, 201);
  });

  app.get('/tenants', async (c) => {
    const tenants = await tenantManager.list();
    return c.json(tenants);
  });

  app.get('/tenants/:id', async (c) => {
    const id = c.req.param('id');
    const tenant = await tenantManager.get(id);
    if (!tenant) return c.json({ error: 'tenant not found' }, 404);
    return c.json(tenant);
  });

  app.post('/tenants/:id/suspend', async (c) => {
    const id = c.req.param('id');
    await tenantManager.suspend(id);
    return c.json({ ok: true });
  });

  app.post('/tenants/:id/activate', async (c) => {
    const id = c.req.param('id');
    await tenantManager.activate(id);
    return c.json({ ok: true });
  });

  app.delete('/tenants/:id', async (c) => {
    const id = c.req.param('id');
    await tenantManager.delete(id);
    return c.json({ ok: true });
  });

  // ─── 成员管理 ───

  app.post('/tenants/:id/members', async (c) => {
    const tenantId = c.req.param('id');
    const tenant = await tenantManager.get(tenantId);
    if (!tenant) return c.json({ error: 'tenant not found' }, 404);

    const body = await c.req.json<{ username: string; password: string; role?: UserRole }>();
    if (!body.username || !body.password) {
      return c.json({ error: 'username and password are required' }, 400);
    }

    const existing = await storage.users.findByUsername(tenantId, body.username);
    if (existing) {
      return c.json({ error: 'username already exists in this tenant' }, 409);
    }

    const passwordHash = await hashPassword(body.password);
    const user = await storage.users.create({
      tenantId,
      username: body.username,
      password: passwordHash,
      role: body.role ?? 'member',
    });

    return c.json({
      id: user.id,
      username: user.username,
      role: user.role,
    }, 201);
  });

  app.get('/tenants/:id/members', async (c) => {
    const tenantId = c.req.param('id');
    const members = await storage.users.listByTenant(tenantId);
    return c.json(members.map((m) => ({
      id: m.id,
      username: m.username,
      role: m.role,
      createdAt: m.createdAt,
    })));
  });

  app.patch('/tenants/:id/members/:userId/role', async (c) => {
    const tenantId = c.req.param('id');
    const userId = c.req.param('userId');
    const body = await c.req.json<{ role: UserRole }>();

    const user = await storage.users.get(userId);
    if (!user || user.tenantId !== tenantId) {
      return c.json({ error: 'member not found in this tenant' }, 404);
    }

    await storage.users.updateRole(userId, body.role);
    return c.json({ ok: true });
  });

  app.delete('/tenants/:id/members/:userId', async (c) => {
    const tenantId = c.req.param('id');
    const userId = c.req.param('userId');

    const user = await storage.users.get(userId);
    if (!user || user.tenantId !== tenantId) {
      return c.json({ error: 'member not found in this tenant' }, 404);
    }

    await storage.users.delete(userId);
    return c.json({ ok: true });
  });

  // ─── 当前用户信息（调试用）───
  app.get('/whoami', (c) => {
    const auth = getAuth(c);
    return c.json(auth);
  });

  return app;
}
