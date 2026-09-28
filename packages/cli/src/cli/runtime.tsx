/**
 * CLI 运行时装配（§6.8）。
 *
 * 装配顺序：config → db → stores → gateway → registry →
 * bus/renderer/bridge → permission → loop → ink render，
 * 全部构造函数 / 参数注入，零内部单例——换掉这一层（如 headless
 * 服务化）即可整体复用内核。
 *
 * 密钥纪律：API key 只从环境（含 cwd 的 .env）读取后直接注入 SDK
 * client，不进配置对象、不落库、不进事件流。
 *
 * Step 9：拆分为 bootstrap()（共享装配）+ launch()（新会话 / resume 入口），
 * runCli() 与 runResume() 分别调用。
 */
import { join } from 'node:path';

import { render } from 'ink';

import { loadConfig, activeApiKey, type ProviderConfig, type ProviderName } from '@yo-harness/core/config/config.js';
import { AgentLoop } from '@yo-harness/core/core/agent-loop.js';
import { TurnBudget } from '@yo-harness/core/core/budget.js';
import { ContextManager } from '@yo-harness/core/core/context-manager.js';
import { EventBus } from '@yo-harness/core/core/event-bus.js';
import { GoalTracker } from '@yo-harness/core/core/goal-tracker.js';
import {
  createInteractivePermission,
  createNonInteractivePermission,
  withApprovalEvents,
} from '@yo-harness/core/core/permission.js';
import { Planner, readOnlyResolver } from '@yo-harness/core/core/planner.js';
import type { Session, SessionStore } from '@yo-harness/core/core/ports.js';
import { FatalError } from '@yo-harness/core/types/errors.js';
import type { AgentEvent, EventEnvelope, TurnEndReason } from '@yo-harness/core/types/events.js';
import type { LLMClient } from '@yo-harness/core/types/llm.js';
import type { Plan } from '@yo-harness/core/types/plan.js';
import { LLMGateway } from '@yo-harness/core/llm/gateway.js';
import { AnthropicLLMClient } from '@yo-harness/core/llm/providers/anthropic.js';
import { FakeLLMClient } from '@yo-harness/core/llm/providers/fake.js';
import { OpenAICompatLLMClient } from '@yo-harness/core/llm/providers/openai-compat.js';
import { ModelRouter } from '@yo-harness/core/router/model-router.js';
import { CostTracker } from '@yo-harness/core/router/cost-tracker.js';
import { McpManager } from '@yo-harness/core/mcp/manager.js';
import { openDatabase, type SqliteDatabase } from '@yo-harness/core/storage/db.js';
import { SqliteEventStore } from '@yo-harness/core/storage/event-store.js';
import { SqliteSessionStore } from '@yo-harness/core/storage/session-store.js';
import { SqliteCheckpointStore } from '@yo-harness/core/storage/checkpoint-store.js';
import { createBuiltinRegistry } from '@yo-harness/core/tools/registry.js';
import { createLogger, parseLogLevel } from '@yo-harness/core/utils/logger.js';
import { yoHome } from '@yo-harness/core/utils/paths.js';
import { createLocalSandbox } from '@yo-harness/core/sandbox/local-sandbox.js';
import type { Logger } from '@yo-harness/core/types/common.js';
import { App } from './app.js';
import { AskBridge } from './approval.js';
import { pickSession } from './picker.js';
import { RenderModel, type RenderLine } from './renderer.js';

/** 每次 LLM 调用的输出上限；与 ContextManager 的 4k 输出预留对齐 */
const DEFAULT_MAX_TOKENS = 4_096;

const SYSTEM_PROMPT = [
  'You are yo, a local-first personal agent running in the user terminal.',
  'You work inside a workspace directory; tool paths are resolved against it and escaping it is rejected.',
  'Accomplish tasks autonomously with the tools: read_file, write_file, list_dir, shell, web_fetch, web_search.',
  'Some actions require user approval and only run after the user allows them.',
  'Prefer small verifiable steps; after running tools, briefly report what you did.',
  'Reply in the same language the user writes in.',
].join('\n');

/** main.ts 解析出的 CLI 选项（undefined = 未提供） */
export interface CliFlags {
  provider: string | undefined;
  model: string | undefined;
  yolo: boolean;
  fake: boolean;
  print: string | undefined;
  plan: string | undefined;
}

/** resume 命令选项 */
export interface ResumeFlags {
  /** 会话 id（完整 UUID 或前 8 字符前缀）；undefined = 弹选择器 */
  sessionId: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  yolo: boolean;
  fake: boolean;
  print: string | undefined;
  plan: string | undefined;
}

/** bootstrap 产物：共享给 runCli / runResume 的已装配依赖 */
interface Bootstrapped {
  config: ReturnType<typeof loadConfig>;
  providerName: ProviderName;
  providerConf: ProviderConfig;
  model: string;
  llm: LLMClient;
  logger: Logger;
  db: SqliteDatabase;
  sessionStore: SqliteSessionStore;
  eventStore: SqliteEventStore;
}

/**
 * .env 加载（Node ≥20.6 内置，无需 dotenv 依赖）：cwd 下的 .env。
 * 文件缺失是常态 → ENOENT 静默跳过；其余失败（权限等）是环境问题 → 上抛。
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new FatalError(`failed to load .env: ${String(err)}`);
    }
  }
}

function buildLlmClient(
  providerName: ProviderName,
  conf: ProviderConfig,
  apiKey: string | undefined,
  fake: boolean,
): LLMClient {
  if (fake) {
    return (
      FakeLLMClient.fromEnv() ??
      new FakeLLMClient([
        {
          text: 'Hello from yo-harness fake provider. Set YO_FAKE_SCRIPT (NDJSON, one response per line) to script richer offline runs.',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 10 },
        },
      ])
    );
  }
  if (apiKey === undefined) {
    throw new FatalError(
      `missing API key for provider "${providerName}": expected env ${conf.apiKeyEnv}\n` +
        '  set it in your environment or in a .env file, adjust apiKeyEnv in ~/.yo-harness/config.json,\n' +
        '  or run with --fake for an offline scripted smoke test',
    );
  }
  const client =
    providerName === 'anthropic'
      ? AnthropicLLMClient.create({
          model: conf.model,
          apiKey,
          ...(conf.baseURL !== undefined ? { baseURL: conf.baseURL } : {}),
        })
      : OpenAICompatLLMClient.create({
          name: providerName,
          model: conf.model,
          apiKey,
          ...(conf.baseURL !== undefined ? { baseURL: conf.baseURL } : {}),
        });
  return client;
}

/**
 * 共享装配：config → db → stores → gateway → registry。
 * 返回的 Bootstrapped 由 runCli / runResume 继续装配 loop + UI。
 */
function bootstrap(flags: { provider: string | undefined; model: string | undefined; yolo: boolean; fake: boolean }): Bootstrapped {
  loadDotEnv();

  const config = loadConfig({
    ...(flags.provider !== undefined ? { flagProvider: flags.provider } : {}),
    ...(flags.model !== undefined ? { flagModel: flags.model } : {}),
    yolo: flags.yolo,
  });
  const providerName = config.defaultProvider;
  const providerConf = config.providers[providerName];
  const model = `${providerName}/${providerConf.model}`;

  const llm = buildLlmClient(providerName, providerConf, activeApiKey(config), flags.fake);
  const logger = createLogger(parseLogLevel(process.env.YO_LOG));

  const db: SqliteDatabase = openDatabase(join(yoHome(), 'sessions.db'));
  const sessionStore = new SqliteSessionStore(db);
  const eventStore = new SqliteEventStore(db);

  return { config, providerName, providerConf, model, llm, logger, db, sessionStore, eventStore };
}

/** `-p <text>`：跑一回合，打印最终 assistant 文本后退出；错误以非零码结束 */
async function runPrintTurn(deps: {
  loop: AgentLoop;
  bus: EventBus;
  text: string;
}): Promise<void> {
  const { loop, bus, text } = deps;
  let lastText = '';
  let lastError: string | undefined;
  const onEvent = (envelope: EventEnvelope): void => {
    const payload = envelope.payload;
    if (payload.type === 'assistant_text' && payload.text.length > 0) lastText = payload.text;
    if (payload.type === 'error') lastError = payload.message;
  };
  bus.on('event', onEvent);
  let reason: TurnEndReason;
  try {
    reason = await loop.runTurn(text);
  } finally {
    bus.off('event', onEvent);
  }
  if (lastText.length > 0) process.stdout.write(`${lastText}\n`);
  if (reason === 'error') {
    process.stderr.write(`yo: turn failed${lastError !== undefined ? `: ${lastError}` : ''}\n`);
    process.exitCode = 1;
  }
}

/**
 * 共享启动：给定 session + 历史事件，装配 loop + UI 并运行。
 * priorEvents 包含 session_started（新会话由调用方构造，resume 由重放得到）。
 */
async function launch(
  boot: Bootstrapped,
  flags: { yolo: boolean; print: string | undefined; plan: string | undefined },
  session: Session,
  priorEvents: AgentEvent[],
): Promise<void> {
  const { config, providerName, providerConf, llm, logger, db, sessionStore, eventStore } = boot;
  let mcpManager: McpManager | undefined;
  try {
    // 1) 网关
    const gateway = new LLMGateway(new Map([[providerName, llm]]), { defaultProvider: providerName });

    // 1b) 路由器 + 成本追踪
    const router = new ModelRouter(gateway, config.modelRoles ?? {});
    const costTracker = new CostTracker();

    // 2) 工具注册表
    const registry = createBuiltinRegistry({
      ...(config.search !== undefined ? { search: config.search } : {}),
    });

    // 2b) MCP 管理器：并行启动配置的 server，注册工具到 registry
    mcpManager = new McpManager({
      servers: config.mcp,
      registry,
      logger,
    });
    await mcpManager.startAll();
    if (mcpManager.failed.length > 0) {
      logger.warn('mcp servers failed to start', {
        failed: mcpManager.failed.map((f) => f.serverName),
      });
    }

    // 3) 总线 + 渲染折叠器；priorEvents 在 render 前消费进 renderer，
    //    其输出行作为 Static 区初始内容（bus 订阅发生在 App 挂载之后）
    const bus = new EventBus();
    const renderer = new RenderModel();
    const initialLines: RenderLine[] = [];
    for (const event of priorEvents) {
      const lines = renderer.push(event);
      initialLines.push(...lines);
    }

    // 4) 上下文管理器：从历史事件重建（新会话只有 session_started，fromEvents 等价于空）
    const context = ContextManager.fromEvents(priorEvents, { contextWindow: providerConf.contextWindow });

    // 首条 user_input 落库后顺手把会话标题补上（仅当标题为空时）
    const onFirstInput = (envelope: EventEnvelope): void => {
      if (envelope.payload.type !== 'user_input') return;
      bus.off('event', onFirstInput);
      if (session.title.length > 0) return; // resume 已有标题的会话不覆盖
      const title = envelope.payload.content.replace(/\s+/g, ' ').trim().slice(0, 60);
      void sessionStore
        .updateTitle(session.id, title)
        .catch((err: unknown) => logger.warn('failed to set session title', { error: String(err) }));
    };
    bus.on('event', onFirstInput);

    // 5) 权限
    const bridge = new AskBridge();
    const appendAndEmit = async (event: AgentEvent): Promise<void> => {
      const envelope = await eventStore.append(session.id, event);
      bus.emit('event', envelope);
    };
    const permission =
      flags.print !== undefined
        ? createNonInteractivePermission(config.permission)
        : createInteractivePermission(withApprovalEvents(bridge.ask, appendAndEmit), config.permission);

    // 6) 主循环
    const loop = new AgentLoop({
      sessionId: session.id,
      cwd: session.cwd,
      router,
      costTracker,
      store: eventStore,
      tools: registry,
      permission,
      budget: new TurnBudget(config.budget),
      context,
      bus,
      sandbox: createLocalSandbox(session.cwd),
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: DEFAULT_MAX_TOKENS,
      logger,
    });

    // ─── Phase 2 新增装配 ───

    // 7) 检查点存储
    const checkpointStore = config.checkpointing.enabled
      ? new SqliteCheckpointStore(db)
      : undefined;

    // 8) 目标追踪器
    const goalTracker = new GoalTracker({
      driftThreshold: config.goalTracking?.driftThreshold ?? 8,
    });

    // 9) 规划器回调
    const runPlannerFn = async (description: string): Promise<Plan | null> => {
      const planner = new Planner({
        llm,
        tools: readOnlyResolver(registry),
        permission,
        sandbox: createLocalSandbox(session.cwd),
        sessionId: session.id,
        cwd: session.cwd,
        logger,
        bus,
        maxExploreSteps: config.planner?.maxExploreSteps ?? 10,
      });
      const result = await planner.plan(description);
      return result?.plan ?? null;
    };

    // ─── --plan 模式：启动时立即运行规划器 ───
    if (flags.plan !== undefined) {
      const planner = new Planner({
        llm,
        tools: readOnlyResolver(registry),
        permission,
        sandbox: createLocalSandbox(session.cwd),
        sessionId: session.id,
        cwd: session.cwd,
        logger,
        bus,
        maxExploreSteps: config.planner?.maxExploreSteps ?? 10,
      });
      const planResult = await planner.plan(flags.plan);
      if (planResult !== null) {
        // plan_created 事件已在 planner.plan() 内通过 bus 发送
        // UI 挂载后会捕获该事件并显示审批界面
      }
    }

    // 10) 前端
    if (flags.print !== undefined) {
      await runPrintTurn({ loop, bus, text: flags.print });
      return;
    }
    const instance = render(
      <App
        provider={providerName}
        model={providerConf.model}
        contextWindow={providerConf.contextWindow}
        bus={bus}
        renderer={renderer}
        loop={loop}
        askBridge={bridge}
        listSessions={() => sessionStore.listRecent(10)}
        initialLines={initialLines}
        {...(checkpointStore !== undefined ? { checkpointStore } : {})}
        {...(goalTracker !== undefined ? { goalTracker } : {})}
        sessionId={session.id}
        cwd={session.cwd}
        runPlanner={runPlannerFn}
      />,
      { exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
  } finally {
    await mcpManager?.stopAll().catch((err: unknown) => {
      logger.warn('mcp stopAll failed', { error: String(err) });
    });
    db.close();
  }
}

/** 解析会话 id：精确匹配或 8 字符前缀匹配 */
export async function resolveSession(
  sessionStore: SessionStore,
  idOrPrefix: string,
): Promise<Session | undefined> {
  // 先尝试精确匹配
  const exact = await sessionStore.get(idOrPrefix);
  if (exact !== undefined) return exact;
  // 前缀匹配：取最近 100 个会话，找 id 以给定前缀开头的
  if (idOrPrefix.length < 8) return undefined;
  const recent = await sessionStore.listRecent(100);
  const matches = recent.filter((s) => s.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  return undefined;
}

export async function runCli(flags: CliFlags): Promise<void> {
  const boot = bootstrap(flags);
  const cwd = process.cwd();
  const session = await boot.sessionStore.create({ model: boot.model, cwd });

  // 新会话：session_started 作为唯一 priorEvent
  const startedEvent: AgentEvent = { type: 'session_started', model: boot.model, cwd };
  // 落库（launch 内的 appendAndEmit 只处理 loop 产出的事件，session_started 需提前写入）
  await boot.eventStore.append(session.id, startedEvent);

  await launch(boot, { yolo: flags.yolo, print: flags.print, plan: flags.plan }, session, [startedEvent]);
}

export async function runResume(flags: ResumeFlags): Promise<void> {
  const boot = bootstrap({ provider: flags.provider, model: flags.model, yolo: flags.yolo, fake: flags.fake });
  const { sessionStore, eventStore, logger } = boot;

  // 1) 解析目标会话
  let session: Session | undefined;
  if (flags.sessionId !== undefined) {
    session = await resolveSession(sessionStore, flags.sessionId);
    if (session === undefined) {
      throw new FatalError(
        `session not found: "${flags.sessionId}"\n` +
          '  run `yo` then `/sessions` to list recent sessions, or `yo resume` to pick interactively',
      );
    }
  } else {
    const recent = await sessionStore.listRecent(10);
    if (recent.length === 0) {
      throw new FatalError(
        'no sessions to resume\n' +
          '  run `yo` to start a new session first',
      );
    }
    session = await pickSession(recent);
    if (session === undefined) {
      // 用户取消
      return;
    }
  }

  // 2) 重放事件
  const envelopes = await eventStore.replay(session.id);
  const priorEvents = envelopes.map((e) => e.payload);
  if (priorEvents.length === 0) {
    throw new FatalError(`session ${session.id} has no events — data integrity issue`);
  }

  // 3) 刷新 updated_at
  await sessionStore.touch(session.id);

  logger.info('resuming session', { id: session.id.slice(0, 8), events: priorEvents.length, model: session.model });

  // 4) 启动（launch 内 renderer 会 fold 全部 priorEvents 为 initialLines）
  await launch(boot, { yolo: flags.yolo, print: flags.print, plan: flags.plan }, session, priorEvents);
}
