/**
 * 服务端配置：模型 provider、预算、权限等。
 *
 * 服务端不直接依赖 CLI 的 loadConfig（避免引入 CLI 侧的 zod schema），
 * 而是定义自己的 ServerConfig 接口，由 app 装配层注入。
 */
import type { BudgetLimits } from '@yo-harness/core/core/budget.js';
import { DEFAULT_BUDGET_LIMITS } from '@yo-harness/core/core/budget.js';
import type { PermissionSettings } from '@yo-harness/core/core/permission.js';
import { DEFAULT_PERMISSION_SETTINGS } from '@yo-harness/core/core/permission.js';
import { DEFAULT_PRICING_TABLE } from '@yo-harness/core/llm/pricing.js';
import type { PricingTable } from '@yo-harness/core/types/pricing.js';
import type { ModelRoleMap } from '@yo-harness/core/types/router.js';

export type { ProviderName } from '@yo-harness/core/config/config.js';

export interface ModelProviderConfig {
  provider: string;
  model: string;
  contextWindow: number;
  baseURL?: string;
}

export interface ServerConfig {
  mode: 'single' | 'multi';
  defaultCwd: string;
  providers: ModelProviderConfig[];
  modelRoles: ModelRoleMap;
  budget: BudgetLimits;
  permission: PermissionSettings;
  systemPrompt: string;
  maxTokens: number;
  contextWindow: number;
  /** §9.1 成本：价格表（决定会话事件是否带 cost） */
  pricing: PricingTable;
  /** 语义记忆自动化配置 */
  memory: MemoryConfig;
}

export const DEFAULT_SYSTEM_PROMPT = [
  'You are yo, a local-first personal agent running in the user terminal.',
  'You work inside a workspace directory; tool paths are resolved against it and escaping it is rejected.',
  'Accomplish tasks autonomously with the tools: read_file, write_file, list_dir, shell, web_fetch, web_search.',
  'Prefer small verifiable steps; after running tools, briefly report what you did.',
  'Reply in the same language the user writes in.',
].join('\n');

export const DEFAULT_MAX_TOKENS = 4_096;
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** 语义记忆自动化配置（自动注入 + 自动提取） */
export interface MemoryConfig {
  /** 每个 turn 是否注入 active 记忆 */
  autoInject: boolean;
  /** turn 结束后是否自动提取记忆 */
  autoExtract: boolean;
  /** all = 全量 active；relevant = 按用户输入 FTS 检索 */
  injectMode: 'all' | 'relevant';
  /** 单次注入条数上限 */
  injectMaxItems: number;
  /** 单次注入 token 预算上限（估算） */
  injectMaxTokens: number;
  /** 单 turn 累积的最低提取字符数 */
  extractMinChars: number;
  /** 会话关闭 flush 时的最低提取字符数 */
  extractFlushMinChars: number;
  /** 提取 LLM 温度 */
  extractorTemperature: number;
  /** 进提取 prompt 的已有标题上限 */
  maxExistingTitles: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  autoInject: true,
  autoExtract: true,
  injectMode: 'all',
  injectMaxItems: 50,
  injectMaxTokens: 2_000,
  extractMinChars: 300,
  extractFlushMinChars: 100,
  extractorTemperature: 0,
  maxExistingTitles: 200,
};

export function createDefaultServerConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    mode: 'single',
    defaultCwd: process.cwd(),
    providers: [],
    modelRoles: {},
    budget: DEFAULT_BUDGET_LIMITS,
    permission: DEFAULT_PERMISSION_SETTINGS,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxTokens: DEFAULT_MAX_TOKENS,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    pricing: DEFAULT_PRICING_TABLE,
    memory: DEFAULT_MEMORY_CONFIG,
    ...overrides,
  };
}
