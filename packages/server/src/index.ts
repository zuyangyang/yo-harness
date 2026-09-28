/**
 * yo-harness headless server 入口。
 *
 * 提供两种使用方式：
 * 1. 编程式：import { createApp, createServer } from '@yo-harness/server'
 * 2. 命令行：tsx src/index.ts（直接启动 HTTP 服务）
 */
import { serve } from '@hono/node-server';

import type { ToolResolver } from '@yo-harness/core/core/ports.js';
import { CostTracker } from '@yo-harness/core/router/cost-tracker.js';
import { ModelRouter } from '@yo-harness/core/router/model-router.js';
import { LLMGateway } from '@yo-harness/core/llm/gateway.js';
import { FakeLLMClient } from '@yo-harness/core/llm/providers/fake.js';
import { createBuiltinRegistry } from '@yo-harness/core/tools/registry.js';
import { createLogger } from '@yo-harness/core/utils/logger.js';
import { createLocalSandbox } from '@yo-harness/core/sandbox/local-sandbox.js';

import { createApp } from './app.js';
import { SessionManager } from './session-manager.js';
import { createJwtConfig } from './auth/jwt.js';
import { createDefaultServerConfig, type ServerConfig } from './config.js';
import {
  SqliteBackend,
  createSqliteBackend,
  PostgresBackend,
  createPostgresBackend,
} from './storage/index.js';
import type { StorageBackend, PostgresConfig } from './storage/index.js';

export {
  SqliteBackend,
  createSqliteBackend,
  PostgresBackend,
  createPostgresBackend,
} from './storage/index.js';
export type { StorageBackend, PostgresConfig } from './storage/index.js';
export { createApp } from './app.js';
export type { AppDeps } from './app.js';
export { SessionManager } from './session-manager.js';
export type { SessionManagerDeps, PendingApproval } from './session-manager.js';
export { createDefaultServerConfig } from './config.js';
export type { ServerConfig, ModelProviderConfig } from './config.js';

export interface CreateServerOptions {
  storage: StorageBackend;
  serverConfig?: ServerConfig;
  jwtSecret?: string;
}

export async function createServer(options: CreateServerOptions) {
  const { storage, serverConfig: configOverrides } = options;
  const serverConfig = configOverrides ?? createDefaultServerConfig();

  await storage.initialize();

  const jwtConfig = createJwtConfig({
    secret: options.jwtSecret ?? process.env.YO_JWT_SECRET ?? 'dev-secret-change-me',
  });

  const logger = createLogger('info');
  const tools: ToolResolver = createBuiltinRegistry();

  const providerName = serverConfig.providers[0]?.provider ?? 'fake';
  const fakeClient = new FakeLLMClient([{ text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]);
  const gateway = new LLMGateway(new Map([[providerName, fakeClient]]), {
    defaultProvider: providerName,
  });
  const router = new ModelRouter(gateway, serverConfig.modelRoles);
  const costTracker = new CostTracker();

  const sessionManager = new SessionManager({
    eventStore: storage.events,
    sessionStore: storage.sessions,
    tools,
    router,
    costTracker,
    sandbox: createLocalSandbox(process.cwd()),
    logger,
    systemPrompt: serverConfig.systemPrompt,
    maxTokens: serverConfig.maxTokens,
    contextWindow: serverConfig.contextWindow,
    budgetLimits: serverConfig.budget,
    permission: serverConfig.permission,
  });

  const { app, wsHub, injectWebSocket } = createApp({
    storage,
    sessionManager,
    jwtConfig,
    serverConfig,
  });

  return { app, wsHub, injectWebSocket, sessionManager, storage };
}

export interface StartServerOptions extends CreateServerOptions {
  port?: number;
}

export async function startServer(options: StartServerOptions): Promise<void> {
  const port = options.port ?? Number(process.env.YO_PORT ?? 3456);
  const result = await createServer(options);
  const { app, injectWebSocket, sessionManager, storage } = result;

  const server = serve({ fetch: app.fetch, port });
  injectWebSocket(server as unknown as import('node:http').Server);

  console.log(`[yo-server] listening on http://localhost:${port}`);
  console.log(`[yo-server] mode: ${options.serverConfig?.mode ?? 'single'}`);

  const shutdown = async (): Promise<void> => {
    console.log('[yo-server] shutting down...');
    await sessionManager.destroyAll();
    await storage.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
