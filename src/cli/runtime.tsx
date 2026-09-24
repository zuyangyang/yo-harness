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
 */
import { join } from 'node:path';

import { render } from 'ink';

import { loadConfig, activeApiKey, type ProviderConfig, type ProviderName } from '../config/config.js';
import { AgentLoop } from '../core/agent-loop.js';
import { TurnBudget } from '../core/budget.js';
import { ContextManager } from '../core/context-manager.js';
import { EventBus } from '../core/event-bus.js';
import {
  createInteractivePermission,
  createNonInteractivePermission,
  withApprovalEvents,
} from '../core/permission.js';
import { FatalError } from '../types/errors.js';
import type { AgentEvent, EventEnvelope, TurnEndReason } from '../types/events.js';
import type { LLMClient } from '../types/llm.js';
import { LLMGateway } from '../llm/gateway.js';
import { AnthropicLLMClient } from '../llm/providers/anthropic.js';
import { FakeLLMClient } from '../llm/providers/fake.js';
import { OpenAICompatLLMClient } from '../llm/providers/openai-compat.js';
import { openDatabase, type SqliteDatabase } from '../storage/db.js';
import { SqliteEventStore } from '../storage/event-store.js';
import { SqliteSessionStore } from '../storage/session-store.js';
import { createBuiltinRegistry } from '../tools/registry.js';
import { createLogger, parseLogLevel } from '../utils/logger.js';
import { yoHome } from '../utils/paths.js';
import { App } from './app.js';
import { AskBridge } from './approval.js';
import { RenderModel } from './renderer.js';

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

export async function runCli(flags: CliFlags): Promise<void> {
  loadDotEnv();

  // 1) 配置：flag > 环境变量 > ~/.yo-harness/config.json > 内置默认
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

  // 2) 存储 + 会话（events 外键约束 session 必须先存在）
  const db: SqliteDatabase = openDatabase(join(yoHome(), 'sessions.db'));
  try {
    const sessionStore = new SqliteSessionStore(db);
    const eventStore = new SqliteEventStore(db);
    const cwd = process.cwd();
    const session = await sessionStore.create({ model, cwd });

    // 3) 网关：单活跃 provider（Phase 1 不做多 provider 路由）
    const gateway = new LLMGateway(new Map([[providerName, llm]]), { defaultProvider: providerName });

    // 4) 工具注册表（search 配置缺失时 web_search 运行时给出指引）
    const registry = createBuiltinRegistry({
      ...(config.search !== undefined ? { search: config.search } : {}),
    });

    // 5) 总线 + 渲染折叠器；session_started 在 render 前消费进 renderer，
    //    其输出行作为 Static 区初始内容（bus 订阅发生在 App 挂载之后）
    const bus = new EventBus();
    const renderer = new RenderModel();
    const started = await eventStore.append(session.id, { type: 'session_started', model, cwd });
    const initialLines = renderer.push(started.payload);

    // 首条 user_input 落库后顺手把会话标题补上（/sessions 列表可读性）
    const onFirstInput = (envelope: EventEnvelope): void => {
      if (envelope.payload.type !== 'user_input') return;
      bus.off('event', onFirstInput);
      const title = envelope.payload.content.replace(/\s+/g, ' ').trim().slice(0, 60);
      void sessionStore
        .updateTitle(session.id, title)
        .catch((err: unknown) => logger.warn('failed to set session title', { error: String(err) }));
    };
    bus.on('event', onFirstInput);

    // 6) 权限：交互模式经审批桥问 UI；-p 模式无人可问，安全默认拒绝
    const bridge = new AskBridge();
    const appendAndEmit = async (event: AgentEvent): Promise<void> => {
      const envelope = await eventStore.append(session.id, event);
      bus.emit('event', envelope);
    };
    const permission =
      flags.print !== undefined
        ? createNonInteractivePermission(config.permission)
        : createInteractivePermission(withApprovalEvents(bridge.ask, appendAndEmit), config.permission);

    // 7) 主循环
    const loop = new AgentLoop({
      sessionId: session.id,
      cwd,
      llm: gateway,
      store: eventStore,
      tools: registry,
      permission,
      budget: new TurnBudget(config.budget),
      context: new ContextManager({ contextWindow: providerConf.contextWindow }),
      bus,
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: DEFAULT_MAX_TOKENS,
      logger,
    });

    // 8) 前端：-p 打印模式无 TUI
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
      />,
      { exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
  } finally {
    db.close();
  }
}
