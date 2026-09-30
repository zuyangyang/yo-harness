/**
 * 生效模型配置解析（设计文档 docs/MODEL-CONFIG-DESIGN.md §4）。
 *
 * 优先级：Web UI 持久化配置 > 环境变量（.env）> ~/.yo-harness/config.json > 内置默认。
 *
 * 纯函数：不读环境、不碰数据库、不做 IO；密钥通过 resolveStoredKey 回调注入，
 * 使 core 层保持对存储 / 加密实现无感知（依赖倒置）。
 *
 * 降级语义：Web UI 配置存在但不可用（provider 缺失 / 地址非法 / 缺密钥）时，
 * **不抛错**，回退到 env 路径并把原因写进 warnings，由 UI 展示。
 */
import type {
  ConfigSource,
  EffectiveModelConfig,
  ModelSelection,
  ProviderKind,
  ProviderProfile,
} from '../types/model-config.js';

/** 与 ~/.yo-harness/config.json 结构兼容的最小视图（避免 core 依赖 zod schema） */
export interface FileModelDefaults {
  defaultProvider?: string | undefined;
  providers?: Partial<
    Record<ProviderKind, { model?: string | undefined; baseURL?: string | undefined; contextWindow?: number | undefined }>
  >;
}

export interface ResolveModelInput {
  /** Web UI 持久化配置；未配置时为 undefined */
  persisted?:
    | {
        selection: ModelSelection | undefined;
        profiles: ProviderProfile[];
      }
    | undefined;
  /** 取某个 provider 的凭据：先查存储（解密），再查环境变量；取不到返回 undefined */
  resolveStoredKey: (providerId: string) => string | undefined;
  /** 环境变量来源（.env 已并入 process.env） */
  env: Record<string, string | undefined>;
  /** 配置文件默认值（仅 CLI 本地模式使用；server 传 undefined） */
  file?: FileModelDefaults | undefined;
}

/** 内置默认：与 config.ts 的 PROVIDER_DEFAULTS 保持一致 */
const PROVIDER_DEFAULTS: Record<ProviderKind, { model: string; contextWindow: number }> = {
  anthropic: { model: 'claude-sonnet-4-5', contextWindow: 200_000 },
  'openai-compat': { model: 'deepseek-chat', contextWindow: 128_000 },
};

/** providerId → 存放 API key 的环境变量名（与 server 既有约定一致） */
export function apiKeyEnvName(providerId: string): string {
  if (providerId === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (providerId === 'openai-compat') return 'OPENAI_COMPAT_API_KEY';
  return `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/** 非 anthropic 的 provider 一律按 OpenAI 兼容协议处理（与 server 既有行为一致） */
export function kindForProviderId(providerId: string): ProviderKind {
  return providerId === 'anthropic' ? 'anthropic' : 'openai-compat';
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isValidBaseURL(url: string | undefined): boolean {
  if (url === undefined) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** env / file / 默认 三级解析 */
function resolveFromEnv(
  env: Record<string, string | undefined>,
  file: FileModelDefaults | undefined,
): EffectiveModelConfig {
  const envProvider = firstNonEmpty(env.YO_PROVIDER);
  const fileProvider = firstNonEmpty(file?.defaultProvider);
  const providerId = envProvider ?? fileProvider ?? 'anthropic';
  const kind = kindForProviderId(providerId);

  const fileProviderConf = file?.providers?.[kind];
  const apiKey = firstNonEmpty(env[apiKeyEnvName(providerId)]);

  let source: ConfigSource = 'default';
  if (envProvider !== undefined || firstNonEmpty(env.YO_MODEL) !== undefined || firstNonEmpty(env.YO_BASE_URL) !== undefined) {
    source = 'env';
  } else if (fileProvider !== undefined || fileProviderConf !== undefined) {
    source = 'file';
  }

  return {
    source,
    providerId,
    kind,
    baseURL: firstNonEmpty(env.YO_BASE_URL, fileProviderConf?.baseURL),
    model: firstNonEmpty(env.YO_MODEL, fileProviderConf?.model) ?? PROVIDER_DEFAULTS[kind].model,
    contextWindow: fileProviderConf?.contextWindow ?? PROVIDER_DEFAULTS[kind].contextWindow,
    apiKey,
    warnings: [],
  };
}

/** Web UI 档案 + 选择 → 生效配置；返回 undefined 表示该配置不可用（需降级） */
function resolveFromPersisted(input: ResolveModelInput, warnings: string[]): EffectiveModelConfig | undefined {
  const persisted = input.persisted;
  const selection = persisted?.selection;
  if (persisted === undefined || selection === undefined) return undefined;

  const profile = persisted.profiles.find((candidate) => candidate.id === selection.providerId);
  if (profile === undefined) {
    warnings.push(`Web UI 选择的 provider "${selection.providerId}" 不存在，已回退`);
    return undefined;
  }
  if (!isValidBaseURL(profile.baseURL)) {
    warnings.push(`Web UI 中 provider "${profile.displayName}" 的 API 地址非法，已回退`);
    return undefined;
  }

  const apiKey = input.resolveStoredKey(profile.id);
  if (apiKey === undefined) {
    warnings.push(`Web UI 中 provider "${profile.displayName}" 缺少 API 密钥，已回退`);
    return undefined;
  }

  const descriptor = profile.models.find((model) => model.id === selection.model);
  return {
    source: 'web',
    providerId: profile.id,
    kind: profile.kind,
    baseURL: profile.baseURL,
    model: selection.model,
    contextWindow: descriptor?.contextWindow ?? PROVIDER_DEFAULTS[profile.kind].contextWindow,
    apiKey,
    warnings,
  };
}

export function resolveEffectiveModel(input: ResolveModelInput): EffectiveModelConfig {
  const warnings: string[] = [];
  const fromWeb = resolveFromPersisted(input, warnings);
  if (fromWeb !== undefined) return fromWeb;

  const fallback = resolveFromEnv(input.env, input.file);
  return { ...fallback, warnings };
}
