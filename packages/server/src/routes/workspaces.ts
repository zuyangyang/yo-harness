/**
 * 工作区管理路由：创建 / 列表 / 详情 / 更新 / 删除。
 *
 * 删除语义（见 docs/SESSION-WORKSPACE-DESIGN.md §10.2）：
 * - 默认（purge=false）：其下会话解绑为独立会话（FK ON DELETE SET NULL）
 * - purge=true：连同其下会话级联删除（不可恢复）
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { SessionManager } from '../session-manager.js';
import type { Workspace } from '@yo-harness/core/core/ports.js';
import { requirePermission } from '../auth/rbac.js';

export interface WorkspacesRouteDeps {
  sessionManager: SessionManager;
}

export function createWorkspaceRoutes(deps: WorkspacesRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const { sessionManager } = deps;

  app.use('*', requirePermission('workspaces:read'));

  app.post('/', requirePermission('workspaces:write'), async (c) => {
    const storage = c.get('storage');
    const body = await c.req.json<{
      name?: string;
      description?: string;
      color?: string;
      icon?: string;
    }>();

    const name = (body.name ?? '').trim();
    if (name === '') {
      return c.json({ error: 'name is required' }, 400);
    }
    if (name.length > 64) {
      return c.json({ error: 'name too long' }, 400);
    }

    const workspace = await storage.workspaces.create({
      name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
    });
    return c.json({ workspace }, 201);
  });

  app.get('/', async (c) => {
    const storage = c.get('storage');
    const workspaces = await storage.workspaces.list();
    return c.json({ workspaces });
  });

  app.get('/:id', async (c) => {
    const storage = c.get('storage');
    const workspace = await storage.workspaces.get(c.req.param('id'));
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    return c.json({ workspace });
  });

  app.patch('/:id', requirePermission('workspaces:write'), async (c) => {
    const storage = c.get('storage');
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      description?: string;
      color?: string;
      icon?: string;
      sortOrder?: number;
    }>();

    const existing = await storage.workspaces.get(id);
    if (!existing) {
      return c.json({ error: 'workspace not found' }, 404);
    }

    const patch: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'sortOrder'>> = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (name === '') {
        return c.json({ error: 'name must not be empty' }, 400);
      }
      if (name.length > 64) {
        return c.json({ error: 'name too long' }, 400);
      }
      patch.name = name;
    }
    if (body.description !== undefined) patch.description = body.description;
    if (body.color !== undefined) patch.color = body.color;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;

    const workspace = await storage.workspaces.update(id, patch);
    return c.json({ workspace });
  });

  app.delete('/:id', requirePermission('workspaces:write'), async (c) => {
    const storage = c.get('storage');
    const id = c.req.param('id');
    const purge = c.req.query('purge') === 'true';

    const workspace = await storage.workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }

    if (purge) {
      const sessions = await storage.sessions.list({ workspaceId: id, limit: 200 });
      for (const session of sessions) {
        sessionManager.closeSession(session.id);
        await storage.sessions.delete(session.id);
      }
    }

    await storage.workspaces.delete(id);
    return c.json({ ok: true });
  });

  return app;
}
