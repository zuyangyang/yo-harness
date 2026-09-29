/**
 * yo-harness headless server 入口。
 *
 * 提供两种使用方式：
 * 1. 编程式：import { createApp, createServer } from '@yo-harness/server'
 * 2. 命令行：tsx src/index.ts（直接启动 HTTP 服务）
 */
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { ToolResolver } from '@yo-harness/core/core/ports.js';
import { CostTracker } from '@yo-harness/core/router/cost-tracker.js';
import { ModelRouter } from '@yo-harness/core/router/model-router.js';
import { LLMGateway } from '@yo-harness/core/llm/gateway.js';
import { FakeLLMClient } from '@yo-harness/core/llm/providers/fake.js';
import { AnthropicLLMClient } from '@yo-harness/core/llm/providers/anthropic.js';
import { OpenAICompatLLMClient } from '@yo-harness/core/llm/providers/openai-compat.js';
import type { LLMClient } from '@yo-harness/core/types/llm.js';
import { createBuiltinRegistry } from '@yo-harness/core/tools/registry.js';
import { createLogger } from '@yo-harness/core/utils/logger.js';
import { createLocalSandbox } from '@yo-harness/core/sandbox/local-sandbox.js';

import { createApp } from './app.js';
import { SessionManager } from './session-manager.js';
import { createJwtConfig } from './auth/jwt.js';
import { createDefaultServerConfig, type ServerConfig, type ModelProviderConfig } from './config.js';
import { WebSocketHub } from './ws/hub.js';
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
  const providerConf = serverConfig.providers[0];
  const client = buildServerLlmClient(providerName, providerConf);
  const gateway = new LLMGateway(new Map([[providerName, client]]), {
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

  const wsHub = new WebSocketHub({ sessionManager });
  sessionManager.setWebSocketHub(wsHub);

  const { app, injectWebSocket } = createApp({
    storage,
    sessionManager,
    jwtConfig,
    serverConfig,
    wsHub,
  });

  return { app, wsHub, injectWebSocket, sessionManager, storage };
}

export interface StartServerOptions extends CreateServerOptions {
  port?: number;
}

const API_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  'openai-compat': 'OPENAI_COMPAT_API_KEY',
};

function buildServerLlmClient(providerName: string, conf?: ModelProviderConfig): LLMClient {
  if (!conf || providerName === 'fake') {
    return new FakeLLMClient([{ text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]);
  }
  const apiKeyEnvName = API_KEY_ENV[providerName] ?? `${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  const apiKey = process.env[apiKeyEnvName];
  if (!apiKey) {
    console.warn(`[yo-server] no API key found for provider "${providerName}" (env ${apiKeyEnvName}), falling back to fake`);
    return new FakeLLMClient([{ text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }]);
  }
  if (providerName === 'anthropic') {
    return AnthropicLLMClient.create({ model: conf.model, apiKey, ...(conf.baseURL ? { baseURL: conf.baseURL } : {}) });
  }
  return OpenAICompatLLMClient.create({ name: providerName, model: conf.model, apiKey, ...(conf.baseURL ? { baseURL: conf.baseURL } : {}) });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

function loadDotEnv(): void {
  try {
    process.loadEnvFile(join(PROJECT_ROOT, '.env'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
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

// ─── CLI 入口 ───
async function main() {
  loadDotEnv();
  const storageType = process.env.YO_STORAGE ?? 'sqlite';
  const port = Number(process.env.YO_PORT ?? 3456);

  let storage: StorageBackend;
  if (storageType === 'postgres') {
    storage = createPostgresBackend({
      host: process.env.YO_PG_HOST ?? 'localhost',
      port: Number(process.env.YO_PG_PORT ?? 5432),
      database: process.env.YO_PG_DATABASE ?? 'yo_harness',
      user: process.env.YO_PG_USER ?? 'postgres',
      password: process.env.YO_PG_PASSWORD ?? 'postgres',
    }, 'public');
  } else {
    const dbPath = process.env.YO_SQLITE_PATH ?? 'data/yo-harness.db';
    storage = createSqliteBackend(dbPath);
  }

  const serverConfig = createDefaultServerConfig({
    mode: (process.env.YO_MODE as 'single' | 'multi') ?? 'single',
    providers: process.env.YO_PROVIDER
      ? [{
          provider: process.env.YO_PROVIDER,
          model: process.env.YO_MODEL ?? 'gpt-4',
          contextWindow: 200_000,
          ...(process.env.YO_BASE_URL ? { baseURL: process.env.YO_BASE_URL } : {}),
        }]
      : [],
  });

  await startServer({
    storage,
    serverConfig,
    ...(process.env.YO_JWT_SECRET ? { jwtSecret: process.env.YO_JWT_SECRET } : {}),
    port,
  });
}

main().catch((err) => {
  console.error('[yo-server] failed to start:', err);
  process.exit(1);
});
