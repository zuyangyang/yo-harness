/**
 * 审批路由：查看待审批 + 通过/拒绝。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { SessionManager, PendingApproval } from '../session-manager.js';
import { requirePermission } from '../auth/rbac.js';

/**
 * 待审批 DTO：前端统一读 approvalId；保留 id 一个版本以兼容旧客户端。
 */
export function toPendingApprovalDto(a: PendingApproval): Record<string, unknown> {
  return {
    approvalId: a.id,
    id: a.id,
    sessionId: a.sessionId,
    callId: a.callId,
    toolName: a.toolName,
    summary: a.summary,
    createdAt: a.createdAt,
  };
}

export interface ApprovalsRouteDeps {
  sessionManager: SessionManager;
}

export function createApprovalRoutes(deps: ApprovalsRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const { sessionManager } = deps;

  app.use('*', requirePermission('sessions:read'));

  app.get('/sessions/:id/approvals/pending', (c) => {
    const sessionId = c.req.param('id');
    const approvals = sessionManager.getPendingApprovals(sessionId).map(toPendingApprovalDto);
    return c.json({ approvals });
  });

  app.post('/approvals/:id/resolve', requirePermission('sessions:write'), async (c) => {
    const approvalId = c.req.param('id');
    const body = await c.req.json<{
      approved?: boolean;
      scope?: 'once' | 'session';
      resolution?: 'once' | 'session' | 'always' | 'deny' | 'deny_and_stop';
    }>();

    // 新协议优先 resolution；旧客户端回退 approved/scope
    const approved =
      body.resolution !== undefined
        ? body.resolution !== 'deny' && body.resolution !== 'deny_and_stop'
        : body.approved;

    if (typeof approved !== 'boolean') {
      return c.json({ error: 'approved (boolean) or resolution is required' }, 400);
    }

    const scope =
      body.scope ??
      (body.resolution === 'session' || body.resolution === 'always' ? 'session' : 'once');

    const resolved = sessionManager.resolveApproval(approvalId, approved, scope);

    if (!resolved) {
      return c.json({ error: 'approval not found' }, 404);
    }

    return c.json({ ok: true, approved, scope });
  });

  return app;
}
