/**
 * 模型定价类型（§9.1）：金额单位 USD / 1M tokens。
 *
 * 价格会随供应商调整而变动，内置表仅作默认值，config 可覆盖。
 */
import type { Usage } from './events.js';

/** 单个模型的价格 */
export interface ModelPrice {
  /** 输入（含缓存未命中）价格，USD / 1M tokens */
  inputPerMillion: number;
  /** 输出价格，USD / 1M tokens */
  outputPerMillion: number;
  /** 缓存命中输入价格，USD / 1M tokens（Anthropic 特有；缺省按 inputPerMillion 计） */
  cachedInputPerMillion?: number;
}

/** key: provider + '/' + model */
export type PricingTable = Record<string, ModelPrice>;

/**
 * 估算单次调用成本（USD）。
 * 无价格时返回 undefined（fake / 未登记模型仅展示 token）。
 */
export function estimateCost(usage: Usage, price: ModelPrice | undefined): number | undefined {
  if (price === undefined) return undefined;
  const cachedTokens = usage.cachedInputTokens ?? 0;
  const cachedPrice = price.cachedInputPerMillion ?? price.inputPerMillion;
  const inputCost = (usage.inputTokens / 1_000_000) * price.inputPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * price.outputPerMillion;
  const cachedCost = (cachedTokens / 1_000_000) * cachedPrice;
  return inputCost + outputCost + cachedCost;
}
