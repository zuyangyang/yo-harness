/**
 * 审批路由：查看待审批 + 通过/拒绝。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { SessionManager } from '../session-manager.js';
import { requirePermission } from '../auth/rbac.js';

export interface ApprovalsRouteDeps {
  sessionManager: SessionManager;
}

export function createApprovalRoutes(deps: ApprovalsRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const { sessionManager } = deps;

  app.use('*', requirePermission('sessions:read'));

  app.get('/sessions/:id/approvals/pending', async (c) => {
    const sessionId = c.req.param('id');
    const approvals = sessionManager.getPendingApprovals(sessionId);
    return c.json({ approvals });
  });

  app.post('/approvals/:id/resolve', requirePermission('sessions:write'), async (c) => {
    const approvalId = c.req.param('id');
    const body = await c.req.json<{ approved: boolean; scope?: 'once' | 'session' }>();

    if (typeof body.approved !== 'boolean') {
      return c.json({ error: 'approved (boolean) is required' }, 400);
    }

    const resolved = sessionManager.resolveApproval(
      approvalId,
      body.approved,
      body.scope ?? 'once',
    );

    if (!resolved) {
      return c.json({ error: 'approval not found' }, 404);
    }

    return c.json({ ok: true });
  });

  return app;
}
