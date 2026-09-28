/**
 * 会话管理路由：创建 / 列表 / 详情 / 删除。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { StorageBackend } from '../storage/interface.js';
import type { SessionManager } from '../session-manager.js';
import { getAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/rbac.js';

export interface SessionsRouteDeps {
  storage: StorageBackend;
  sessionManager: SessionManager;
}

export function createSessionRoutes(deps: SessionsRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const { sessionManager } = deps;

  app.use('*', requirePermission('sessions:read'));

  app.post('/', requirePermission('sessions:write'), async (c) => {
    const storage = c.get('storage');
    const body = await c.req.json<{
      title?: string;
      model?: string;
      cwd?: string;
    }>();

    const auth = getAuth(c);
    const input: { model: string; cwd: string; title?: string; type: 'interactive' } = {
      model: body.model ?? 'default',
      cwd: body.cwd ?? process.cwd(),
      type: 'interactive',
    };
    if (body.title !== undefined) {
      input.title = body.title;
    }
    const session = await storage.sessions.create(input);

    return c.json({ session, userId: auth.userId }, 201);
  });

  app.get('/', async (c) => {
    const storage = c.get('storage');
    const limit = Number(c.req.query('limit') ?? '20');
    const sessions = await storage.sessions.listRecent(Math.min(limit, 100));
    return c.json({ sessions });
  });

  app.get('/:id', async (c) => {
    const storage = c.get('storage');
    const session = await storage.sessions.get(c.req.param('id'));
    if (!session) {
      return c.json({ error: 'session not found' }, 404);
    }
    return c.json({ session });
  });

  app.delete('/:id', requirePermission('sessions:write'), async (c) => {
    const storage = c.get('storage');
    const id = c.req.param('id');
    const session = await storage.sessions.get(id);
    if (!session) {
      return c.json({ error: 'session not found' }, 404);
    }
    sessionManager.closeSession(id);
    await storage.sessions.updateTitle(id, '__deleted__');
    return c.json({ ok: true });
  });

  return app;
}
