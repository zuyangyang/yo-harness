/**
 * Daemon 进程入口：后台任务调度器。
 *
 * 职责：
 * 1. 监听 Unix socket（~/.yo-harness/daemon.sock）接收 CLI 请求；
 * 2. 管理后台任务生命周期（创建 TaskRunner → 异步执行 → 更新状态）；
 * 3. 空闲超时自动退出（默认 5 分钟无请求则退出，避免常驻进程）；
 * 4. 单例锁（~/.yo-harness/daemon.lock）防止多实例。
 *
 * 启动方式：`yo daemon`（手动）或 `yo bg` 首次提交任务时自动拉起。
 * 停止方式：`yo daemon-stop` 或空闲超时。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd as getCwd } from 'node:process';

import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';

import { loadConfig, activeApiKey, type ProviderConfig, type ProviderName } from '../config/config.js';
import { TurnBudget } from '../core/budget.js';
import { ContextManager } from '../core/context-manager.js';
import { EventBus } from '../core/event-bus.js';
import { createNonInteractivePermission } from '../core/permission.js';
import { LLMGateway } from '../llm/gateway.js';
import { AnthropicLLMClient } from '../llm/providers/anthropic.js';
import { FakeLLMClient } from '../llm/providers/fake.js';
import { OpenAICompatLLMClient } from '../llm/providers/openai-compat.js';
import { ModelRouter } from '../router/model-router.js';
import { CostTracker } from '../router/cost-tracker.js';
import { openDatabase } from '../storage/db.js';
import { SqliteEventStore } from '../storage/event-store.js';
import { SqliteSessionStore } from '../storage/session-store.js';
import { SqliteTaskStore } from '../storage/task-store.js';
import { createBuiltinRegistry } from '../tools/registry.js';
import { FatalError } from '../types/errors.js';
import type { Logger } from '../types/common.js';
import { createLogger, parseLogLevel } from '../utils/logger.js';
import { yoHome } from '../utils/paths.js';
import { TaskRunner } from './task-runner.js';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SOCKET_PATH = join(yoHome(), 'daemon.sock');
const DEFAULT_LOCK_PATH = join(yoHome(), 'daemon.lock');

export interface DaemonConfig {
  socketPath?: string;
  lockPath?: string;
  idleTimeoutMs?: number;
}

export async function startDaemon(config: DaemonConfig = {}): Promise<void> {
  const socketPath = config.socketPath ?? DEFAULT_SOCKET_PATH;
  const lockPath = config.lockPath ?? DEFAULT_LOCK_PATH;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  if (existsSync(lockPath)) {
    const pid = readFileSync(lockPath, 'utf8').trim();
    throw new FatalError(`daemon already running (pid ${pid})\n  stop it with: yo daemon-stop`);
  }

  writeFileSync(lockPath, String(process.pid), 'utf8');

  const cleanup = (): void => {
    try {
      rmSync(lockPath, { force: true });
      rmSync(socketPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  const logger = createLogger(parseLogLevel(process.env.YO_LOG));
  const appConfig = loadConfig();

  const db = openDatabase(join(yoHome(), 'sessions.db'));
  const sessionStore = new SqliteSessionStore(db);
  const eventStore = new SqliteEventStore(db);
  const taskStore = new SqliteTaskStore(db);

  const providerName = appConfig.defaultProvider;
  const providerConf = appConfig.providers[providerName];
  const apiKey = activeApiKey(appConfig);

  const llm = apiKey === undefined
    ? new FakeLLMClient([{ text: 'fake mode', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }])
    : providerName === 'anthropic'
      ? AnthropicLLMClient.create({ model: providerConf.model, apiKey, ...(providerConf.baseURL !== undefined ? { baseURL: providerConf.baseURL } : {}) })
      : OpenAICompatLLMClient.create({ name: providerName, model: providerConf.model, apiKey, ...(providerConf.baseURL !== undefined ? { baseURL: providerConf.baseURL } : {}) });

  const gateway = new LLMGateway(new Map([[providerName, llm]]), { defaultProvider: providerName });
  const router = new ModelRouter(gateway, appConfig.modelRoles ?? {});
  const costTracker = new CostTracker();
  const registry = createBuiltinRegistry({ ...(appConfig.search !== undefined ? { search: appConfig.search } : {}) });

  const runner = new TaskRunner({
    taskStore,
    sessionStore,
    eventStore,
    tools: registry,
    router,
    costTracker,
    logger,
    systemPrompt: 'You are yo, a local-first personal agent.',
    maxTokens: 4096,
    budgetLimits: appConfig.budget,
    contextWindow: providerConf.contextWindow,
  });

  const app = new Hono();
  let lastActivity = Date.now();

  app.post('/tasks/start', async (c) => {
    lastActivity = Date.now();
    const body = await c.req.json<{ prompt: string; cwd: string; model: string }>();
    const task = await taskStore.create({ description: body.prompt, cwd: body.cwd, model: body.model });
    void runner.run({ taskId: task.id, prompt: body.prompt, cwd: body.cwd, model: body.model }).catch((err) => {
      logger.error('task runner error', { taskId: task.id, error: String(err) });
    });
    return c.json({ taskId: task.id, sessionId: task.sessionId });
  });

  app.get('/tasks', async (c) => {
    lastActivity = Date.now();
    const limit = Number(c.req.query('limit') ?? 20);
    const tasks = await taskStore.list(limit);
    return c.json(tasks);
  });

  app.get('/tasks/:id', async (c) => {
    lastActivity = Date.now();
    const id = c.req.param('id');
    const task = await taskStore.get(id);
    if (task === undefined) return c.notFound();
    return c.json(task);
  });

  app.post('/tasks/:id/cancel', async (c) => {
    lastActivity = Date.now();
    const id = c.req.param('id');
    await taskStore.updateStatus(id, 'cancelled', 'cancelled');
    return c.json({ ok: true });
  });

  app.post('/daemon/stop', async (c) => {
    cleanup();
    setTimeout(() => process.exit(0), 100);
    return c.json({ ok: true });
  });

  const server = createAdaptorServer(app);

  rmSync(socketPath, { force: true });
  server.listen(socketPath);

  logger.info('daemon started', { pid: process.pid, socket: socketPath });

  const idleCheck = setInterval(() => {
    if (Date.now() - lastActivity > idleTimeoutMs) {
      logger.info('daemon idle timeout, exiting');
      cleanup();
      process.exit(0);
    }
  }, 10000);

  process.on('beforeExit', () => clearInterval(idleCheck));
}
