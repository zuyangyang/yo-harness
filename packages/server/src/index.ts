/**
 * yo-harness headless server 入口。
 *
 * 提供两种使用方式：
 * 1. 编程式：import { createApp, createServer } from '@yo-harness/server'
 * 2. 命令行：tsx src/index.ts（直接启动 HTTP 服务）
 */
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import type { ToolResolver } from '@yo-harness/core/core/ports.js';
import { CostTracker } from '@yo-harness/core/router/cost-tracker.js';
import { createBuiltinRegistry } from '@yo-harness/core/tools/registry.js';
import { createLogger } from '@yo-harness/core/utils/logger.js';
import { createLocalSandbox } from '@yo-harness/core/sandbox/local-sandbox.js';
import { loadPricingOverrides } from '@yo-harness/core/config/config.js';
import { mergePricingTable } from '@yo-harness/core/llm/pricing.js';
import type { PricingTable } from '@yo-harness/core/types/pricing.js';

import { createApp } from './app.js';
import { SessionManager } from './session-manager.js';
import { createJwtConfig } from './auth/jwt.js';
import { createDefaultServerConfig, type ServerConfig } from './config.js';
import { ModelConfigService } from './model-config-service.js';
import { WebSocketHub } from './ws/hub.js';
import { createSqliteBackend, createPostgresBackend } from './storage/index.js';
import type { StorageBackend } from './storage/index.js';

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

  // 模型配置：Web UI 持久化配置优先，未配置时回退 .env（见 model-config-service）
  // onChange 需要的两个依赖在下方才创建，故用可空引用延迟绑定
  const refs: { sessionManager?: SessionManager; wsHub?: WebSocketHub } = {};

  const modelConfig = new ModelConfigService({
    store: storage.modelConfig,
    logger,
    onChange: (next) => {
      // 在途 turn 不打断，只驱逐空闲会话，使其下一条消息用新配置重建
      const evicted = refs.sessionManager?.onModelConfigChanged() ?? 0;
      if (evicted > 0) logger.info('idle sessions evicted after model config change', { evicted });
      refs.wsHub?.broadcastAll({
        type: 'model_config_changed',
        providerId: next.providerId,
        model: next.model,
        source: next.source,
      });
    },
  });
  // 预热：尽早暴露配置问题（缺密钥会回落到 Fake，不阻塞启动）
  await modelConfig.getRuntime();
  const costTracker = new CostTracker();

  const sessionManager = new SessionManager({
    eventStore: storage.events,
    sessionStore: storage.sessions,
    tools,
    resolveRuntime: async (session) => {
      const runtime = await modelConfig.buildRuntimeForModel(session.model);
      return {
        router: runtime.router,
        contextWindow: runtime.contextWindow,
        model: runtime.model,
      };
    },
    costTracker,
    pricing: serverConfig.pricing,
    sandbox: createLocalSandbox(process.cwd()),
    logger,
    systemPrompt: serverConfig.systemPrompt,
    maxTokens: serverConfig.maxTokens,
    budgetLimits: serverConfig.budget,
    permission: serverConfig.permission,
  });
  refs.sessionManager = sessionManager;

  const wsHub = new WebSocketHub({ sessionManager });
  refs.wsHub = wsHub;
  sessionManager.setWebSocketHub(wsHub);

  const { app, injectWebSocket } = createApp({
    storage,
    sessionManager,
    jwtConfig,
    serverConfig,
    modelConfig,
    wsHub,
  });

  return { app, wsHub, injectWebSocket, sessionManager, storage, modelConfig };
}

export interface StartServerOptions extends CreateServerOptions {
  port?: number;
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
  injectWebSocket(server as unknown as Server);

  console.log(`[yo-server] listening on http://localhost:${port}`);
  console.log(`[yo-server] mode: ${options.serverConfig?.mode ?? 'single'}`);

  const shutdown = async (): Promise<void> => {
    console.log('[yo-server] shutting down...');
    await sessionManager.destroyAll();
    await storage.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
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

  // 价格覆盖：~/.yo-harness/config.json 的 pricing 段（缺失/非法不阻塞启动，仅告警）
  let pricingOverrides: PricingTable | undefined;
  try {
    pricingOverrides = loadPricingOverrides();
  } catch (err) {
    console.warn('[yo-server] ignoring invalid pricing config:', String(err));
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
    pricing: mergePricingTable(pricingOverrides),
  });

  await startServer({
    storage,
    serverConfig,
    ...(process.env.YO_JWT_SECRET ? { jwtSecret: process.env.YO_JWT_SECRET } : {}),
    port,
  });
}

// 仅当本文件作为入口被直接执行时才启动监听；
// 作为库被 import（测试 / 编程式嵌入）时不得产生副作用。
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => {
    console.error('[yo-server] failed to start:', err);
    process.exit(1);
  });
}
