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

/**
 * 查价格：先精确匹配 `${provider}/${model}`，未命中再退化为「按模型名匹配」。
 *
 * 退化的意义：用户自定义 provider id（如网关别名 wlyd）与内置 key 对不上时，
 * 只要模型名已登记仍能算出成本。同名模型被多家登记时按插入顺序取第一个。
 * 未登记返回 undefined（调用方据此只展示 token，不展示金额）。
 */
export function lookupPrice(
  table: PricingTable,
  provider: string,
  model: string,
): ModelPrice | undefined {
  // 1) 精确 `${provider}/${model}`；2) 仅模型名（与 provider 无关，便于自定义网关）
  const exact = table[`${provider}/${model}`] ?? table[model];
  if (exact !== undefined) return exact;
  // 3) 退化为后缀匹配：任意 provider 前缀下的同名模型
  const suffix = `/${model}`;
  for (const [key, price] of Object.entries(table)) {
    if (key.endsWith(suffix)) return price;
  }
  return undefined;
}

/** 把用户覆盖项叠加到内置默认表（同名 key 覆盖默认值） */
export function mergePricingTable(overrides: PricingTable | undefined): PricingTable {
  return overrides === undefined ? DEFAULT_PRICING_TABLE : { ...DEFAULT_PRICING_TABLE, ...overrides };
}
