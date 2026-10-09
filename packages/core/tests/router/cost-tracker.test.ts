import { describe, expect, it } from 'vitest';
import { CostTracker } from '../../src/router/cost-tracker.js';

describe('CostTracker', () => {
  it('record + total 汇总', () => {
    const tracker = new CostTracker();
    tracker.record({ role: 'main', provider: 'anthropic', model: 'claude', inputTokens: 100, outputTokens: 50 });
    tracker.record({ role: 'main', provider: 'anthropic', model: 'claude', inputTokens: 200, outputTokens: 80 });
    tracker.record({ role: 'compressor', provider: 'openai-compat', model: 'deepseek', inputTokens: 50, outputTokens: 20 });

    expect(tracker.total()).toEqual({ inputTokens: 350, outputTokens: 150 });
  });

  it('summaryByRole 按角色分组', () => {
    const tracker = new CostTracker();
    tracker.record({ role: 'main', provider: 'anthropic', model: 'claude', inputTokens: 100, outputTokens: 50 });
    tracker.record({ role: 'main', provider: 'anthropic', model: 'claude', inputTokens: 200, outputTokens: 80 });
    tracker.record({ role: 'compressor', provider: 'openai-compat', model: 'deepseek', inputTokens: 50, outputTokens: 20 });

    const summary = tracker.summaryByRole();
    expect(summary.get('main')).toEqual({ inputTokens: 300, outputTokens: 130, callCount: 2 });
    expect(summary.get('compressor')).toEqual({ inputTokens: 50, outputTokens: 20, callCount: 1 });
  });

  it('reset 清空记录', () => {
    const tracker = new CostTracker();
    tracker.record({ role: 'main', provider: 'anthropic', model: 'claude', inputTokens: 100, outputTokens: 50 });
    tracker.reset();

    expect(tracker.total()).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tracker.summaryByRole().size).toBe(0);
  });

  it('空记录返回零', () => {
    const tracker = new CostTracker();
    expect(tracker.total()).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tracker.summaryByRole().size).toBe(0);
  });

  it('带价格时累计成本，无价格时仅 token', () => {
    const tracker = new CostTracker();
    const price = { inputPerMillion: 1, outputPerMillion: 2 };
    tracker.record(
      { role: 'main', provider: 'p', model: 'm', inputTokens: 1_000_000, outputTokens: 1_000_000 },
      price,
    );
    tracker.record({ role: 'main', provider: 'p', model: 'm', inputTokens: 1_000_000, outputTokens: 1_000_000 });

    const total = tracker.total();
    // 第一次有价：1M/1M * 1 + 1M/1M * 2 = 3；第二次无价不计
    expect(total.inputTokens).toBe(2_000_000);
    expect(total.outputTokens).toBe(2_000_000);
    expect(total.cost).toBe(3);
  });

  it('cachedInputPerMillion 缺省按 inputPerMillion 计', () => {
    const tracker = new CostTracker();
    const price = { inputPerMillion: 1, outputPerMillion: 2 };
    tracker.record(
      { role: 'main', provider: 'p', model: 'm', inputTokens: 1_000_000, outputTokens: 0 },
      price,
    );

    expect(tracker.total().cost).toBe(1);
  });
});
