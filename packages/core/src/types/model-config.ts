/**
 * 模型配置领域类型（Web UI 模型配置）。
 *
 * 设计文档：docs/MODEL-CONFIG-DESIGN.md §3。
 *
 * 约定：
 * - 这里只描述「可持久化 / 可展示的配置形态」，不含明文密钥；
 * - 运行期生效配置（EffectiveModelConfig）里的 apiKey 只在内存中流转，
 *   绝不进入持久化、事件流或日志。
 */

/** 调用协议：OpenAI Chat Completions 兼容 / Anthropic 原生 */
export type ProviderKind = 'openai-compat' | 'anthropic';

/** 生效配置来源，用于 UI 展示与排障 */
export type ConfigSource = 'web' | 'env' | 'file' | 'default';

/** 模型目录中的一项 */
export interface ModelDescriptor {
  /** 传入 provider 的模型 id */
  id: string;
  /** 可选上下文窗口；缺省回退 provider 级默认 */
  contextWindow?: number;
}

/** 持久化的 Provider 档案（不含任何形式的密钥） */
export interface ProviderProfile {
  id: string;
  displayName: string;
  kind: ProviderKind;
  /** openai-compat 必填；anthropic 缺省用官方端点 */
  baseURL: string | undefined;
  /** 是否已存有可用凭据（含来自环境变量的） */
  hasKey: boolean;
  /** 形如 'sk-…c0eA'，仅用于展示；无凭据时为 undefined */
  apiKeyHint: string | undefined;
  /** 模型目录 */
  models: ModelDescriptor[];
  sortOrder: number;
}

/** 当前生效的 provider + 模型选择 */
export interface ModelSelection {
  providerId: string;
  model: string;
}

/**
 * 持久化 Provider 的写入形态（内部使用）。
 *
 * apiKeyCipher 与 apiKeyEnv 二选一：
 * - 前者是加密后的密钥（密钥永不进日志 / 事件 / API 响应）；
 * - 后者只存环境变量名，凭据仍由 .env 提供。
 */
export interface ProviderRecordInput {
  id: string;
  displayName: string;
  kind: ProviderKind;
  baseURL: string | undefined;
  apiKeyCipher: string | undefined;
  apiKeyHint: string | undefined;
  apiKeyEnv: string | undefined;
  models: ModelDescriptor[];
  defaultContextWindow: number | undefined;
  sortOrder: number;
}

/** 持久化 Provider 的读取形态（附带时间戳） */
export interface ProviderRecord extends ProviderRecordInput {
  createdAt: string;
  updatedAt: string;
}

/** 解析优先级后的最终生效配置 */
export interface EffectiveModelConfig {
  source: ConfigSource;
  providerId: string;
  kind: ProviderKind;
  baseURL: string | undefined;
  model: string;
  contextWindow: number;
  /** 运行期注入，绝不持久化 / 记录 */
  apiKey: string | undefined;
  /** UI 可展示的降级原因 */
  warnings: string[];
}
