/**
 * 后台任务路由：列表 / 详情 / 取消。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { StorageBackend } from '../storage/interface.js';
import { requirePermission } from '../auth/rbac.js';

export interface TasksRouteDeps {
  storage: StorageBackend;
}

export function createTaskRoutes(_deps: TasksRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  app.use('*', requirePermission('tasks:read'));

  app.get('/', async (c) => {
    const store = c.get('storage');
    const limit = Number(c.req.query('limit') ?? '20');
    const tasks = await store.tasks.list(Math.min(limit, 100));
    return c.json({ tasks });
  });

  app.get('/:id', async (c) => {
    const store = c.get('storage');
    const task = await store.tasks.get(c.req.param('id'));
    if (!task) {
      return c.json({ error: 'task not found' }, 404);
    }
    return c.json({ task });
  });

  app.post('/:id/cancel', requirePermission('tasks:write'), async (c) => {
    const store = c.get('storage');
    const id = c.req.param('id');
    const task = await store.tasks.get(id);
    if (!task) {
      return c.json({ error: 'task not found' }, 404);
    }
    if (task.status !== 'pending' && task.status !== 'running') {
      return c.json({ error: `task is ${task.status}, cannot cancel` }, 409);
    }
    await store.tasks.updateStatus(id, 'cancelled', 'cancelled');
    return c.json({ ok: true });
  });

  return app;
}
