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
    ...overrides,
  };
}
