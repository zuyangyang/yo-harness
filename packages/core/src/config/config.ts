/**
 * 应用配置（§5.5）：优先级 CLI flag > 环境变量 > `~/.yo-harness/config.json` > 内置默认。
 *
 * 文件 schema 用 zod 严格校验（未知字段直接报错，拼错键名能在启动时暴露），
 * 任何解析失败抛 FatalError 并给出修复提示 —— 配置层的问题必须在进程
 * 起来之前挡住，绝不带病运行。
 *
 * 安全约定：配置文件里只存「API key 的环境变量名」（apiKeyEnv），
 * 永远不存 key 本身；密钥只从进程环境读，不落库、不入日志、不进事件。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { McpServerConfig } from '../mcp/types.js';
import type { BudgetLimits } from '../core/budget.js';
import { DEFAULT_BUDGET_LIMITS } from '../core/budget.js';
import type { PermissionSettings } from '../core/permission.js';
import type { ModelRole, ModelRoleMap } from '../types/router.js';
import type { WebSearchSettings } from '../tools/web.js';
import { FatalError } from '../types/errors.js';
import { yoHome } from '../utils/paths.js';

export type ProviderName = 'anthropic' | 'openai-compat';

/** 单个 LLM provider 的最终生效配置（密钥变量名 + 模型 + 窗口） */
export interface ProviderConfig {
  /** 存放 API key 的环境变量名；实际 key 只从进程环境读 */
  apiKeyEnv: string;
  model: string;
  contextWindow: number;
  /** openai-compat 专属；缺省用 SDK 默认端点 */
  baseURL?: string;
}

/** Phase 2: 自适应压缩配置 */
export interface CompressionSettings {
  enabled: boolean;
  /** 用哪个 provider 做压缩（可选，缺省用默认 provider） */
  provider?: ProviderName;
  /** 压缩专用模型（可选，覆盖 provider 默认模型） */
  model?: string;
  /** 触发压缩的阈值比例（默认 0.7） */
  triggerRatio: number;
  /** 单条摘要的 token 上限（默认 200） */
  maxTokensPerSummary: number;
}

/** Phase 2: 检查点配置 */
export interface CheckpointingSettings {
  enabled: boolean;
}

/** Phase 2: 规划器配置 */
export interface PlannerSettings {
  /** 最大探索步数（默认 10） */
  maxExploreSteps: number;
}

/** Phase 2: 目标追踪配置 */
export interface GoalTrackingSettings {
  /** 连续多少步无进展时注入提醒（默认 8） */
  driftThreshold: number;
}

/** Phase 3: daemon 配置 */
export interface DaemonSettings {
  /** 空闲超时毫秒数（默认 5 分钟） */
  idleTimeoutMs: number;
}

export interface AppConfig {
  defaultProvider: ProviderName;
  providers: Record<ProviderName, ProviderConfig>;
  /** 缺省未配置 → web_search 工具返回引导性错误而非崩溃 */
  search: WebSearchSettings | undefined;
  permission: PermissionSettings;
  budget: BudgetLimits;
  /** Phase 2: 自适应压缩配置（可选） */
  compression: CompressionSettings | undefined;
  /** Phase 2: 检查点配置（可选，默认启用） */
  checkpointing: CheckpointingSettings;
  /** Phase 2: 规划器配置（可选） */
  planner: PlannerSettings | undefined;
  /** Phase 2: 目标追踪配置（可选） */
  goalTracking: GoalTrackingSettings | undefined;
  /** Phase 3: 角色 → 模型映射（可选，未配置的角色回退默认 provider） */
  modelRoles: ModelRoleMap | undefined;
  /** 主对话 temperature（缺省 undefined = 不传 = provider 默认） */
  temperature: number | undefined;
  /** 角色级 temperature 覆盖（缺省 undefined = 子任务固定 0） */
  roleTemperature: Partial<Record<ModelRole, number>> | undefined;
  /** Phase 3: 工具 schema 下发模式（默认 full；compact 裁到顶层属性名） */
  toolsSchemaMode: 'full' | 'compact' | undefined;
  /** Phase 3: MCP server 配置（可选，未配置则不启动任何 MCP client） */
  mcp: Record<string, McpServerConfig>;
  /** Phase 3: daemon 配置（可选） */
  daemon: DaemonSettings | undefined;
}

/** 内置默认：不写任何配置文件也能跑（当然，调用真实 API 还需要环境变量里有 key） */
const PROVIDER_DEFAULTS: Record<ProviderName, Omit<ProviderConfig, 'baseURL'>> = {
  anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5', contextWindow: 200_000 },
  'openai-compat': {
    apiKeyEnv: 'OPENAI_COMPAT_API_KEY',
    model: 'deepseek-chat',
    contextWindow: 128_000,
  },
};

const providerFileSchema = z.strictObject({
  apiKeyEnv: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  baseURL: z.string().min(1).optional(),
});

const configFileSchema = z.strictObject({
  defaultProvider: z.enum(['anthropic', 'openai-compat']).optional(),
  providers: z
    .strictObject({
      anthropic: providerFileSchema.optional(),
      'openai-compat': providerFileSchema.optional(),
    })
    .optional(),
  search: z
    .strictObject({
      provider: z.enum(['tavily', 'bocha', 'serper']),
      apiKeyEnv: z.string().min(1).optional(),
    })
    .optional(),
  permission: z
    .strictObject({
      /** 三级权限模式（新）；缺省由 shellMode 推导 */
      mode: z.enum(['ask', 'auto', 'full']).optional(),
      shellMode: z.enum(['ask', 'allowlist', 'auto', 'yolo']).optional(),
      shellAllowlist: z.array(z.string().min(1)).optional(),
      approvalTimeoutMs: z.number().int().nonnegative().optional(),
      outsideWorkspace: z.enum(['ask', 'deny']).optional(),
    })
    .optional(),
  budget: z
    .strictObject({
      maxStepsPerTurn: z.number().int().positive().optional(),
      maxTokensPerTurn: z.number().int().positive().optional(),
      maxTurnDurationMs: z.number().int().positive().optional(),
    })
    .optional(),
  compression: z
    .strictObject({
      enabled: z.boolean().optional(),
      provider: z.enum(['anthropic', 'openai-compat']).optional(),
      model: z.string().min(1).optional(),
      triggerRatio: z.number().min(0).max(1).optional(),
      maxTokensPerSummary: z.number().int().positive().optional(),
    })
    .optional(),
  checkpointing: z
    .strictObject({
      enabled: z.boolean().optional(),
    })
    .optional(),
  planner: z
    .strictObject({
      maxExploreSteps: z.number().int().positive().optional(),
    })
    .optional(),
  goalTracking: z
    .strictObject({
      driftThreshold: z.number().int().positive().optional(),
    })
    .optional(),
  modelRoles: z
    .strictObject({
      main: z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
      planner: z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
      compressor: z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
      extractor: z.strictObject({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
    })
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  roleTemperature: z
    .strictObject({
      main: z.number().min(0).max(2).optional(),
      planner: z.number().min(0).max(2).optional(),
      compressor: z.number().min(0).max(2).optional(),
      extractor: z.number().min(0).max(2).optional(),
    })
    .optional(),
  toolsSchemaMode: z.enum(['full', 'compact']).optional(),
  mcp: z
    .record(
      z.string().min(1),
      z.strictObject({
        command: z.string().min(1),
        args: z.array(z.string()),
        env: z.record(z.string().min(1), z.string()).optional(),
        startupTimeoutMs: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  daemon: z
    .strictObject({
      idleTimeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
});

type ConfigFile = z.infer<typeof configFileSchema>;

/** loadConfig 的注入点：CLI flag 优先，测试注入 env 与配置文件路径 */
export interface ConfigOverrides {
  /** `--provider`：anthropic | openai-compat */
  flagProvider?: string;
  /** `--model`：作用于生效中的 provider */
  flagModel?: string;
  /** `--yolo`：全量放行审批（覆盖文件里的 shellMode） */
  yolo?: boolean;
  /** 配置文件路径；缺省 `~/.yo-harness/config.json`（受 YO_DATA_DIR 影响） */
  configPath?: string;
  /** 环境变量来源；缺省 process.env（读 YO_PROVIDER / YO_MODEL） */
  env?: Record<string, string | undefined>;
}

/** 逐个取第一个非空字符串（空白视为未设置） */
function pickText(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readConfigFile(configPath: string): ConfigFile | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new FatalError(`cannot read config file ${configPath}: ${String(err)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new FatalError(
      `config file ${configPath} is not valid JSON: ${String(err)}\n` +
        '  fix the JSON syntax, or delete the file to fall back to defaults',
    );
  }

  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('\n');
    throw new FatalError(
      `config file ${configPath} failed validation:\n${issues}\n` +
        '  fix the listed fields, or delete the file to fall back to defaults',
    );
  }
  return parsed.data;
}

function resolveProvider(overrides: ConfigOverrides, env: Record<string, string | undefined>, file: ConfigFile | undefined): ProviderName {
  const raw = pickText(overrides.flagProvider, env.YO_PROVIDER, file?.defaultProvider);
  if (raw === undefined) return 'anthropic';
  if (raw !== 'anthropic' && raw !== 'openai-compat') {
    throw new FatalError(
      `unknown provider "${raw}" — expected "anthropic" or "openai-compat".\n` +
        '  set it via --provider <name>, YO_PROVIDER=<name>, or "defaultProvider" in config.json',
    );
  }
  return raw;
}

function buildProvider(name: ProviderName, file: ConfigFile | undefined, model: string): ProviderConfig {
  const fromFile = file?.providers?.[name];
  const defaults = PROVIDER_DEFAULTS[name];
  const config: ProviderConfig = {
    apiKeyEnv: fromFile?.apiKeyEnv ?? defaults.apiKeyEnv,
    model,
    contextWindow: fromFile?.contextWindow ?? defaults.contextWindow,
  };
  if (fromFile?.baseURL !== undefined) config.baseURL = fromFile.baseURL;
  return config;
}

/**
 * model 的优先级（flag > env > file > 默认）只作用于生效中的 provider；
 * 另一个 provider 保持自己的 file/默认 model，避免 flag 误改到没在用的那家。
 */
function modelFor(
  name: ProviderName,
  activeProvider: ProviderName,
  activeModel: string,
  file: ConfigFile | undefined,
): string {
  if (name === activeProvider) return activeModel;
  return pickText(file?.providers?.[name]?.model) ?? PROVIDER_DEFAULTS[name].model;
}

/** exactOptionalPropertyTypes：显式重建，避免把 `?: string | undefined` 透传给下游 */
function buildSearch(file: ConfigFile | undefined): WebSearchSettings | undefined {
  const fromFile = file?.search;
  if (fromFile === undefined) return undefined;
  const settings: WebSearchSettings = { provider: fromFile.provider };
  if (fromFile.apiKeyEnv !== undefined) settings.apiKeyEnv = fromFile.apiKeyEnv;
  return settings;
}

/** Phase 2: 构建压缩配置 */
function buildCompression(file: ConfigFile | undefined): CompressionSettings | undefined {
  const fromFile = file?.compression;
  if (fromFile === undefined) return undefined;
  
  const settings: CompressionSettings = {
    enabled: fromFile.enabled ?? true,
    triggerRatio: fromFile.triggerRatio ?? 0.7,
    maxTokensPerSummary: fromFile.maxTokensPerSummary ?? 200,
  };
  
  if (fromFile.provider !== undefined) settings.provider = fromFile.provider;
  if (fromFile.model !== undefined) settings.model = fromFile.model;
  
  return settings;
}

/** Phase 2: 构建检查点配置 */
function buildCheckpointing(file: ConfigFile | undefined): CheckpointingSettings {
  return {
    enabled: file?.checkpointing?.enabled ?? true,
  };
}

/** Phase 2: 构建规划器配置 */
function buildPlanner(file: ConfigFile | undefined): PlannerSettings | undefined {
  const fromFile = file?.planner;
  if (fromFile === undefined) return undefined;
  return {
    maxExploreSteps: fromFile.maxExploreSteps ?? 10,
  };
}

/** Phase 2: 构建目标追踪配置 */
function buildGoalTracking(file: ConfigFile | undefined): GoalTrackingSettings | undefined {
  const fromFile = file?.goalTracking;
  if (fromFile === undefined) return undefined;
  return {
    driftThreshold: fromFile.driftThreshold ?? 8,
  };
}

/** Phase 4: 构建角色级 temperature 覆盖 */
function buildRoleTemperature(
  file: ConfigFile | undefined,
): Partial<Record<ModelRole, number>> | undefined {
  const fromFile = file?.roleTemperature;
  if (fromFile === undefined) return undefined;
  const result: Partial<Record<ModelRole, number>> = {};
  if (fromFile.main !== undefined) result.main = fromFile.main;
  if (fromFile.planner !== undefined) result.planner = fromFile.planner;
  if (fromFile.compressor !== undefined) result.compressor = fromFile.compressor;
  if (fromFile.extractor !== undefined) result.extractor = fromFile.extractor;
  if (Object.keys(result).length === 0) return undefined;
  return result;
}

/** Phase 3: 构建角色 → 模型映射 */
function buildModelRoles(file: ConfigFile | undefined): ModelRoleMap | undefined {
  const fromFile = file?.modelRoles;
  if (fromFile === undefined) return undefined;
  const result: ModelRoleMap = {};
  if (fromFile.main !== undefined) result.main = fromFile.main;
  if (fromFile.planner !== undefined) result.planner = fromFile.planner;
  if (fromFile.compressor !== undefined) result.compressor = fromFile.compressor;
  if (fromFile.extractor !== undefined) result.extractor = fromFile.extractor;
  if (Object.keys(result).length === 0) return undefined;
  return result;
}

/** Phase 3: 构建 MCP server 配置（未配置返回空对象） */
function buildMcp(file: ConfigFile | undefined): Record<string, McpServerConfig> {
  const fromFile = file?.mcp;
  if (fromFile === undefined) return {};
  const result: Record<string, McpServerConfig> = {};
  for (const [name, conf] of Object.entries(fromFile)) {
    const server: McpServerConfig = { command: conf.command, args: conf.args };
    if (conf.env !== undefined) server.env = conf.env;
    if (conf.startupTimeoutMs !== undefined) server.startupTimeoutMs = conf.startupTimeoutMs;
    result[name] = server;
  }
  return result;
}

/** Phase 3: 构建 daemon 配置 */
function buildDaemon(file: ConfigFile | undefined): DaemonSettings | undefined {
  const fromFile = file?.daemon;
  if (fromFile === undefined) return undefined;
  return {
    idleTimeoutMs: fromFile.idleTimeoutMs ?? 5 * 60 * 1000,
  };
}

/** 读取并合并全部配置来源；任何失败都是 FatalError（进程应立即退出） */
export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const env = overrides.env ?? process.env;
  const file = readConfigFile(overrides.configPath ?? join(yoHome(), 'config.json'));

  const provider = resolveProvider(overrides, env, file);

  const permissionSettings: PermissionSettings = {
    shellMode: overrides.yolo === true ? 'yolo' : (file?.permission?.shellMode ?? 'ask'),
    shellAllowlist: file?.permission?.shellAllowlist ?? [],
  };
  const configMode = overrides.yolo === true ? 'full' : file?.permission?.mode;
  if (configMode !== undefined) permissionSettings.mode = configMode;
  if (file?.permission?.approvalTimeoutMs !== undefined) {
    permissionSettings.approvalTimeoutMs = file.permission.approvalTimeoutMs;
  }
  if (file?.permission?.outsideWorkspace !== undefined) {
    permissionSettings.outsideWorkspace = file.permission.outsideWorkspace;
  }

  const budgetFile = file?.budget;
  const activeModel =
    pickText(overrides.flagModel, env.YO_MODEL, file?.providers?.[provider]?.model) ??
    PROVIDER_DEFAULTS[provider].model;

  return {
    defaultProvider: provider,
    providers: {
      anthropic: buildProvider('anthropic', file, modelFor('anthropic', provider, activeModel, file)),
      'openai-compat': buildProvider(
        'openai-compat',
        file,
        modelFor('openai-compat', provider, activeModel, file),
      ),
    },
    search: buildSearch(file),
    permission: permissionSettings,
    budget: {
      maxStepsPerTurn: budgetFile?.maxStepsPerTurn ?? DEFAULT_BUDGET_LIMITS.maxStepsPerTurn,
      maxTokensPerTurn: budgetFile?.maxTokensPerTurn ?? DEFAULT_BUDGET_LIMITS.maxTokensPerTurn,
      maxTurnDurationMs: budgetFile?.maxTurnDurationMs ?? DEFAULT_BUDGET_LIMITS.maxTurnDurationMs,
    },
    compression: buildCompression(file),
    checkpointing: buildCheckpointing(file),
    planner: buildPlanner(file),
    goalTracking: buildGoalTracking(file),
    modelRoles: buildModelRoles(file),
    temperature: file?.temperature,
    roleTemperature: buildRoleTemperature(file),
    toolsSchemaMode: file?.toolsSchemaMode,
    mcp: buildMcp(file),
    daemon: buildDaemon(file),
  };
}

/** 取生效 provider 的 API key：只从环境变量读，取不到返回 undefined（由调用方决定报错或 fake 模式） */
export function activeApiKey(config: AppConfig, env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[config.providers[config.defaultProvider].apiKeyEnv];
  return pickText(value);
}
