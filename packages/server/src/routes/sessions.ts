/**
 * 会话管理路由：创建 / 列表（过滤分页）/ 详情 / 更新（改名/移动/置顶/归档）/ 删除。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { StorageBackend } from '../storage/interface.js';
import type { SessionManager } from '../session-manager.js';
import type { SessionListFilter, SessionUpdate } from '@yo-harness/core/core/ports.js';
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
      workspaceId?: string | null;
    }>();

    const auth = getAuth(c);

    // 校验目标工作区（可选）
    let workspaceId: string | null = null;
    if (body.workspaceId !== undefined && body.workspaceId !== null) {
      const ws = await storage.workspaces.get(body.workspaceId);
      if (!ws) {
        return c.json({ error: 'workspace not found' }, 400);
      }
      workspaceId = body.workspaceId;
    }

    const title = body.title ?? '';
    const titleIsCustom = title.trim() !== '';

    const session = await storage.sessions.create({
      model: body.model ?? 'default',
      cwd: body.cwd ?? process.cwd(),
      title,
      titleIsCustom,
      workspaceId,
      type: 'interactive',
    });

    return c.json({ session, userId: auth.userId }, 201);
  });

  app.get('/', async (c) => {
    const storage = c.get('storage');
    const workspaceId = c.req.query('workspaceId');
    const status = c.req.query('status');
    const q = c.req.query('q');
    const pinned = c.req.query('pinned');
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');

    const filter: SessionListFilter = {};
    if (workspaceId === 'none') {
      filter.workspaceId = null;
    } else if (workspaceId !== undefined) {
      filter.workspaceId = workspaceId;
    }
    if (status === 'active' || status === 'archived') {
      filter.status = status;
    }
    if (q !== undefined && q.trim() !== '') {
      filter.query = q.trim();
    }
    if (pinned !== undefined) {
      filter.pinned = pinned === 'true';
    }
    filter.limit = Math.min(Number.isFinite(limit) ? limit : 50, 200);
    if (offset > 0) {
      filter.offset = offset;
    }

    const sessions = await storage.sessions.list(filter);
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

  app.patch('/:id', requirePermission('sessions:write'), async (c) => {
    const storage = c.get('storage');
    const id = c.req.param('id');
    const body = await c.req.json<{
      title?: string;
      workspaceId?: string | null;
      pinned?: boolean;
      status?: 'active' | 'archived';
      model?: string | null;
    }>();

    const existing = await storage.sessions.get(id);
    if (!existing) {
      return c.json({ error: 'session not found' }, 404);
    }

    const patch: SessionUpdate = {};

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (title === '') {
        return c.json({ error: 'title must not be empty' }, 400);
      }
      patch.title = title;
      patch.titleIsCustom = true;
    }

    if (body.workspaceId !== undefined) {
      if (body.workspaceId !== null) {
        const ws = await storage.workspaces.get(body.workspaceId);
        if (!ws) {
          return c.json({ error: 'workspace not found' }, 400);
        }
      }
      patch.workspaceId = body.workspaceId;
    }

    if (body.pinned !== undefined) {
      patch.pinned = body.pinned;
    }

    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'archived') {
        return c.json({ error: 'invalid status' }, 400);
      }
      patch.status = body.status;
    }

    let modelChanged = false;
    if (body.model !== undefined) {
      if (body.model === null) {
        // 清空会话级覆盖，回到全局默认
        patch.model = null;
        modelChanged = existing.model !== '';
      } else {
        const model = body.model.trim();
        if (model === '') {
          return c.json({ error: 'model must not be empty' }, 400);
        }
        patch.model = model;
        modelChanged = model !== existing.model;
      }
    }

    const session = await storage.sessions.update(id, patch);

    // 模型变更后丢弃该会话缓存的 loop，使其下一条消息按新模型重建
    if (modelChanged) {
      sessionManager.invalidateSession(id);
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
    await storage.sessions.delete(id);
    return c.json({ ok: true });
  });

  return app;
}
