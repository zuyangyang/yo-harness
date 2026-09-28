/**
 * 模型路由：列出可用模型 + 角色分配。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { ServerConfig } from '../config.js';

export interface ModelsRouteDeps {
  serverConfig: ServerConfig;
}

export function createModelRoutes(deps: ModelsRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const { serverConfig } = deps;

  app.get('/', (c) => {
    const models = serverConfig.providers.map((p) => ({
      provider: p.provider,
      model: p.model,
      contextWindow: p.contextWindow,
    }));

    const defaultProvider = serverConfig.providers[0];
    const roles = Object.entries(serverConfig.modelRoles).map(([role, cfg]) => ({
      role,
      provider: cfg?.provider ?? defaultProvider?.provider ?? '',
      model: cfg?.model ?? defaultProvider?.model ?? '',
    }));

    return c.json({ models, roles });
  });

  return app;
}
