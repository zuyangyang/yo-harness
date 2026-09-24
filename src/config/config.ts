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

import type { BudgetLimits } from '../core/budget.js';
import { DEFAULT_BUDGET_LIMITS } from '../core/budget.js';
import type { PermissionSettings } from '../core/permission.js';
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

export interface AppConfig {
  defaultProvider: ProviderName;
  providers: Record<ProviderName, ProviderConfig>;
  /** 缺省未配置 → web_search 工具返回引导性错误而非崩溃 */
  search: WebSearchSettings | undefined;
  permission: PermissionSettings;
  budget: BudgetLimits;
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
      shellMode: z.enum(['ask', 'allowlist', 'yolo']).optional(),
      shellAllowlist: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  budget: z
    .strictObject({
      maxStepsPerTurn: z.number().int().positive().optional(),
      maxTokensPerTurn: z.number().int().positive().optional(),
      maxTurnDurationMs: z.number().int().positive().optional(),
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

/** 读取并合并全部配置来源；任何失败都是 FatalError（进程应立即退出） */
export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const env = overrides.env ?? process.env;
  const file = readConfigFile(overrides.configPath ?? join(yoHome(), 'config.json'));

  const provider = resolveProvider(overrides, env, file);

  const permissionSettings: PermissionSettings = {
    shellMode: overrides.yolo === true ? 'yolo' : (file?.permission?.shellMode ?? 'ask'),
    shellAllowlist: file?.permission?.shellAllowlist ?? [],
  };

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
  };
}

/** 取生效 provider 的 API key：只从环境变量读，取不到返回 undefined（由调用方决定报错或 fake 模式） */
export function activeApiKey(config: AppConfig, env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env[config.providers[config.defaultProvider].apiKeyEnv];
  return pickText(value);
}
