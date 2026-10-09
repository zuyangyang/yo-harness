/**
 * 站内通知路由：列表 / 未读数 / 标记已读。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import { requirePermission } from '../auth/rbac.js';

export function createNotificationRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  app.use('*', requirePermission('notifications:read'));

  app.get('/', async (c) => {
    const store = c.get('storage');
    const limit = Number(c.req.query('limit') ?? '50');
    const notifications = await store.notifications.list(
      Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
    );
    const unread = await store.notifications.countUnread();
    return c.json({ notifications, unread });
  });

  app.post('/read-all', requirePermission('notifications:write'), async (c) => {
    const store = c.get('storage');
    await store.notifications.markAllRead();
    return c.json({ ok: true });
  });

  app.post('/:id/read', requirePermission('notifications:write'), async (c) => {
    const store = c.get('storage');
    await store.notifications.markRead(c.req.param('id'));
    return c.json({ ok: true });
  });

  return app;
}
