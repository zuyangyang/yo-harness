/**
 * 对话路由：发送消息（触发 agent turn）+ 获取事件流。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { StorageBackend } from '../storage/interface.js';
import type { SessionManager } from '../session-manager.js';
import { requirePermission } from '../auth/rbac.js';

export interface ConversationsRouteDeps {
  storage: StorageBackend;
  sessionManager: SessionManager;
}

export function createConversationRoutes(deps: ConversationsRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const { sessionManager } = deps;

  app.use('*', requirePermission('sessions:read'));

  app.post('/:id/messages', requirePermission('sessions:write'), async (c) => {
    const storage = c.get('storage');
    const sessionId = c.req.param('id');
    const session = await storage.sessions.get(sessionId);
    if (!session) {
      return c.json({ error: 'session not found' }, 404);
    }

    const body = await c.req.json<{ content: string }>();
    if (!body.content) {
      return c.json({ error: 'content is required' }, 400);
    }

    try {
      const result = await sessionManager.sendMessage(sessionId, body.content);
      return c.json(result, 202);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 409);
    }
  });

  app.get('/:id/events', async (c) => {
    const storage = c.get('storage');
    const sessionId = c.req.param('id');
    const session = await storage.sessions.get(sessionId);
    if (!session) {
      return c.json({ error: 'session not found' }, 404);
    }

    const events = await storage.events.replay(sessionId);
    return c.json({ events });
  });

  app.post('/:id/interrupt', requirePermission('sessions:write'), async (c) => {
    const storage = c.get('storage');
    const sessionId = c.req.param('id');
    const session = await storage.sessions.get(sessionId);
    if (!session) {
      return c.json({ error: 'session not found' }, 404);
    }

    sessionManager.interrupt(sessionId);
    return c.json({ ok: true });
  });

  return app;
}
