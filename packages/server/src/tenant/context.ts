/**
 * 租户上下文：基于 AsyncLocalStorage 实现请求级别的租户隔离。
 *
 * 每个 HTTP 请求通过 `runWithTenant()` 绑定租户上下文，
 * 下游代码通过 `getTenantContext()` 获取当前租户信息，
 * 无需显式传递 tenantId。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  schemaName: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

export function requireTenantContext(): TenantContext {
  const ctx = getTenantContext();
  if (!ctx) throw new Error('no tenant context — request not scoped to a tenant');
  return ctx;
}

export function tenantSchemaName(tenantId: string): string {
  return `tenant_${tenantId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}
