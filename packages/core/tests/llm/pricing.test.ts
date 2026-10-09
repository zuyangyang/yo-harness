import { describe, expect, it } from 'vitest';

import { DEFAULT_PRICING_TABLE, lookupPrice } from '../../src/llm/pricing.js';
import { estimateCost } from '../../src/types/pricing.js';
import type { PricingTable } from '../../src/types/pricing.js';

describe('lookupPrice', () => {
  it('精确命中 provider/model', () => {
    const price = lookupPrice(DEFAULT_PRICING_TABLE, 'anthropic', 'claude-sonnet-4-5');
    expect(price).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cachedInputPerMillion: 0.3,
    });
  });

  it('provider 对不上时按模型名回退（自定义 provider id 也能命中）', () => {
    const price = lookupPrice(DEFAULT_PRICING_TABLE, 'wlyd', 'deepseek-chat');
    expect(price?.inputPerMillion).toBe(0.28);
    expect(price?.outputPerMillion).toBe(1.11);
  });

  it('未登记模型返回 undefined（上层只展示 token）', () => {
    expect(lookupPrice(DEFAULT_PRICING_TABLE, 'wlyd', 'deepseek-v4-pro')).toBeUndefined();
  });

  it('精确 key 优先于同名回退；同名多家登记时取插入顺序第一个', () => {
    const table: PricingTable = {
      'a/m': { inputPerMillion: 1, outputPerMillion: 1 },
      'b/m': { inputPerMillion: 2, outputPerMillion: 2 },
    };
    expect(lookupPrice(table, 'a', 'm')?.inputPerMillion).toBe(1);
    expect(lookupPrice(table, 'b', 'm')?.inputPerMillion).toBe(2);
    expect(lookupPrice(table, 'c', 'm')?.inputPerMillion).toBe(1);
  });
});

describe('estimateCost', () => {
  it('按输入/输出分别计价', () => {
    const cost = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { inputPerMillion: 3, outputPerMillion: 15 },
    );
    expect(cost).toBeCloseTo(18, 6);
  });

  it('缓存命中输入按缓存价累加', () => {
    const cost = estimateCost(
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 },
      { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
    );
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it('缓存价缺省时回落为输入价', () => {
    const cost = estimateCost(
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 },
      { inputPerMillion: 3, outputPerMillion: 15 },
    );
    expect(cost).toBeCloseTo(3, 6);
  });

  it('无价格返回 undefined', () => {
    expect(estimateCost({ inputTokens: 10, outputTokens: 5 }, undefined)).toBeUndefined();
  });
});
