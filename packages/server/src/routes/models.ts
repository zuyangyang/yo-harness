/**
 * 模型配置路由（设计文档 docs/MODEL-CONFIG-DESIGN.md §9）。
 *
 * GET    /            provider 列表 + 当前选择 + 生效来源（保留旧版 models/roles 字段）
 * PUT    /providers/:id   新增或更新 Provider（apiKey 为空 = 不改动）
 * DELETE /providers/:id   删除 Provider（若为 active 则清空选择并回退 .env）
 * PUT    /active          保存当前选择
 * POST   /discover        获取 provider 真实可用模型
 *
 * 权限：读取需 models:read；写入需 models:write，多租户模式下收紧为 admin。
 */
import { Hono, type Context } from 'hono';

import type { ServerEnv } from '../types.js';
import type { ServerConfig } from '../config.js';
import type { ModelConfigService } from '../model-config-service.js';
import type { ModelDescriptor, ProviderKind } from '@yo-harness/core/types/model-config.js';
import { FatalError, TransientError, ValidationError } from '@yo-harness/core/types/errors.js';
import { requirePermission } from '../auth/rbac.js';

export interface ModelsRouteDeps {
  serverConfig: ServerConfig;
  modelConfig: ModelConfigService;
}

interface ProviderBody {
  kind?: ProviderKind;
  displayName?: string;
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv?: string | null;
  models?: ModelDescriptor[];
  defaultContextWindow?: number;
  sortOrder?: number;
}

interface ActiveBody {
  providerId?: string;
  model?: string;
}

interface DiscoverBody {
  providerId?: string;
  kind?: ProviderKind;
  baseURL?: string;
  apiKey?: string;
}

function isKind(value: unknown): value is ProviderKind {
  return value === 'openai-compat' || value === 'anthropic';
}

export function createModelRoutes(deps: ModelsRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const { serverConfig, modelConfig } = deps;

  /** 统一错误映射：配置类 400、上游类 502，其余交给全局处理 */
  function guarded(fn: (c: Context<ServerEnv>) => Promise<Response>) {
    return async (c: Context<ServerEnv>): Promise<Response> => {
      try {
        return await fn(c);
      } catch (err) {
        if (err instanceof ValidationError) {
          return c.json({ error: { code: 'invalid_request', message: err.message } }, 400);
        }
        if (err instanceof TransientError) {
          return c.json({ error: { code: 'upstream_unavailable', message: err.message } }, 502);
        }
        if (err instanceof FatalError) {
          return c.json({ error: { code: 'upstream_error', message: err.message } }, 502);
        }
        throw err;
      }
    };
  }

  const writeGuard = serverConfig.mode === 'multi' ? requirePermission('admin') : requirePermission('models:write');

  app.use('*', requirePermission('models:read'));

  app.get(
    '/',
    guarded(async (c) => {
      const view = await modelConfig.view();

      // 旧字段：保持既有 ModelSelector / 客户端不破
      const defaultProvider = serverConfig.providers[0];
      const models = serverConfig.providers.map((p) => ({
        provider: p.provider,
        model: p.model,
        contextWindow: p.contextWindow,
      }));
      const roles = Object.entries(serverConfig.modelRoles).map(([role, cfg]) => ({
        role,
        provider: cfg?.provider ?? defaultProvider?.provider ?? '',
        model: cfg?.model ?? defaultProvider?.model ?? '',
      }));

      return c.json({ ...view, models, roles });
    }),
  );

  app.put(
    '/providers/:id',
    writeGuard,
    guarded(async (c) => {
      const id = c.req.param('id');
      if (id === undefined || id.trim() === '') {
        return c.json({ error: { code: 'invalid_request', message: 'provider id 必填' } }, 400);
      }

      const body = await c.req.json<ProviderBody>();

      if (!isKind(body.kind)) {
        return c.json(
          { error: { code: 'invalid_request', message: 'kind 必须是 "openai-compat" 或 "anthropic"' } },
          400,
        );
      }

      const provider = await modelConfig.saveProvider({
        id,
        kind: body.kind,
        displayName: body.displayName,
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        apiKeyEnv: body.apiKeyEnv,
        models: body.models,
        defaultContextWindow: body.defaultContextWindow,
        sortOrder: body.sortOrder,
      });

      return c.json({ provider });
    }),
  );

  app.delete(
    '/providers/:id',
    writeGuard,
    guarded(async (c) => {
      const id = c.req.param('id');
      if (id === undefined || id.trim() === '') {
        return c.json({ error: { code: 'invalid_request', message: 'provider id 必填' } }, 400);
      }

      await modelConfig.deleteProvider(id);
      return c.json({ ok: true });
    }),
  );

  app.put(
    '/active',
    writeGuard,
    guarded(async (c) => {
      const body = await c.req.json<ActiveBody>();
      if (typeof body.providerId !== 'string' || typeof body.model !== 'string') {
        return c.json({ error: { code: 'invalid_request', message: 'providerId 与 model 必填' } }, 400);
      }

      await modelConfig.saveSelection({ providerId: body.providerId, model: body.model });
      return c.json({ ok: true, active: { providerId: body.providerId, model: body.model } });
    }),
  );

  app.post(
    '/discover',
    guarded(async (c) => {
      const body = await c.req.json<DiscoverBody>();
      if (body.providerId === undefined && !isKind(body.kind)) {
        return c.json(
          { error: { code: 'invalid_request', message: 'providerId 或 kind 至少提供一个' } },
          400,
        );
      }

      const models = await modelConfig.discover({
        providerId: body.providerId,
        kind: body.kind,
        baseURL: body.baseURL,
        apiKey: body.apiKey,
      });

      return c.json({ models });
    }),
  );

  return app;
}
