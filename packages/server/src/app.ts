/**
 * Hono app 装配：把所有路由、中间件、健康检查组装成完整的 HTTP 应用。
 *
 * 中间件链：
 *   公开路由（/health, /ready, /auth/*）→ 无鉴权
 *   受保护路由 → authMiddleware → tenantMiddleware（多租户）/ storageMiddleware（单租户）→ 路由
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

import type { StorageBackend } from './storage/interface.js';
import type { SessionManager } from './session-manager.js';
import type { JwtConfig } from './auth/jwt.js';
import { authMiddleware } from './auth/middleware.js';
import type { TenantManager } from './tenant/manager.js';
import { tenantMiddleware } from './tenant/middleware.js';
import type { ServerConfig } from './config.js';
import type { ServerEnv } from './types.js';

import { createAuthRoutes } from './routes/auth.js';
import { createAdminRoutes } from './routes/admin.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createConversationRoutes } from './routes/conversations.js';
import { createApprovalRoutes } from './routes/approvals.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createMemoryRoutes } from './routes/memories.js';
import { createModelRoutes } from './routes/models.js';

export interface AppDeps {
  storage: StorageBackend;
  sessionManager: SessionManager;
  jwtConfig: JwtConfig;
  serverConfig: ServerConfig;
  tenantManager?: TenantManager;
}

export function createApp(deps: AppDeps): Hono<ServerEnv> {
  const { storage, sessionManager, jwtConfig, serverConfig, tenantManager } = deps;
  const app = new Hono<ServerEnv>();

  app.use('*', cors());

  // ─── 公开路由 ───
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/ready', (c) => {
    const checks: Record<string, string> = { storage: 'ok' };
    const allOk = Object.values(checks).every((v) => v === 'ok');
    return c.json({ status: allOk ? 'ready' : 'not_ready', checks }, allOk ? 200 : 503);
  });

  // ─── 鉴权路由（无需 tenant 上下文） ───
  app.route('/auth', createAuthRoutes({ storage, jwtConfig }));

  // ─── 受保护路由的公共中间件 ───
  const authMW = authMiddleware({ storage, jwtConfig });

  if (serverConfig.mode === 'multi' && tenantManager) {
    const tenantMW = tenantMiddleware(tenantManager);

    app.use('/api/v1/*', authMW);
    app.use('/api/v1/*', tenantMW);
    app.use('/admin/*', authMW);
    app.use('/admin/*', tenantMW);

    app.route('/admin', createAdminRoutes({ storage, jwtConfig, tenantManager }));
  } else {
    const storageMW: MiddlewareHandler = async (c, next) => {
      c.set('storage', storage);
      await next();
    };

    app.use('/api/v1/*', authMW);
    app.use('/api/v1/*', storageMW);
  }

  // ─── 业务路由 ───
  app.route('/api/v1/sessions', createSessionRoutes({ storage, sessionManager }));
  app.route('/api/v1/sessions', createConversationRoutes({ storage, sessionManager }));
  app.route('/api/v1', createApprovalRoutes({ sessionManager }));
  app.route('/api/v1/tasks', createTaskRoutes({ storage }));
  app.route('/api/v1/memories', createMemoryRoutes({ storage }));
  app.route('/api/v1/models', createModelRoutes({ serverConfig }));

  return app;
}
