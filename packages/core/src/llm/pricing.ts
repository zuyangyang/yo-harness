/**
 * 内置默认价格表（§9.1）。
 *
 * 金额为约值（USD / 1M tokens），随供应商调价变动；config.pricing 可覆盖。
 * key 格式：provider + '/' + model。
 */
import type { ModelPrice, PricingTable } from '../types/pricing.js';

export const DEFAULT_PRICING_TABLE: PricingTable = {
  // Anthropic（2025 年公开价）
  'anthropic/claude-sonnet-4-5': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
  },
  'anthropic/claude-opus-4-1': {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cachedInputPerMillion: 1.5,
  },
  'anthropic/claude-haiku-4-5': {
    inputPerMillion: 1,
    outputPerMillion: 5,
    cachedInputPerMillion: 0.1,
  },
  // DeepSeek（2025 年官方价，按约 7.2 汇率折算 USD）
  'openai-compat/deepseek-chat': {
    inputPerMillion: 0.28,
    outputPerMillion: 1.11,
    cachedInputPerMillion: 0.07,
  },
  'openai-compat/deepseek-reasoner': {
    inputPerMillion: 0.56,
    outputPerMillion: 2.19,
    cachedInputPerMillion: 0.14,
  },
};

/** 按 provider + model 查价格；未登记返回 undefined */
export function lookupPrice(
  table: PricingTable,
  provider: string,
  model: string,
): ModelPrice | undefined {
  return table[`${provider}/${model}`];
}
