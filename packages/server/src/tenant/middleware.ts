/**
 * 租户中间件：从 JWT payload 提取 tenantId，设置租户上下文。
 *
 * 必须在 authMiddleware 之后使用（依赖 c.get('auth')）。
 */
import type { MiddlewareHandler } from 'hono';

import { getAuth } from '../auth/middleware.js';
import { runWithTenant, tenantSchemaName } from './context.js';
import type { TenantManager } from './manager.js';

export function tenantMiddleware(manager: TenantManager): MiddlewareHandler {
  return async (c, next) => {
    const auth = getAuth(c);
    const ctx = {
      tenantId: auth.tenantId,
      schemaName: tenantSchemaName(auth.tenantId),
    };

    await runWithTenant(ctx, async () => {
      const backend = await manager.getBackend(auth.tenantId);
      c.set('storage', backend);
      await next();
    });
  };
}
