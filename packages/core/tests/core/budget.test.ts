import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET_LIMITS,
  TurnBudget,
} from '../../src/core/budget.js';
import type { Clock } from '../../src/core/budget.js';
import { BudgetStop } from '../../src/types/errors.js';

/** 可推进的假时钟 */
class FakeClock implements Clock {
  private ms = 0;
  now(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

describe('TurnBudget', () => {
  it('默认限额：40 步 / 50 万 token / 10 分钟', () => {
    expect(DEFAULT_BUDGET_LIMITS).toEqual({
      maxStepsPerTurn: 40,
      maxTokensPerTurn: 500_000,
      maxTurnDurationMs: 600_000,
    });
  });

  it('限额内不抛，snapshot 反映计数', () => {
    const clock = new FakeClock();
    const budget = new TurnBudget(
      { maxStepsPerTurn: 3, maxTokensPerTurn: 1000, maxTurnDurationMs: 5000 },
      clock,
    );

    budget.start();
    budget.countStep();
    budget.guard();
    budget.addUsage(usage(600, 300));
    clock.advance(4999);
    budget.countStep();
    budget.guard();

    expect(budget.snapshot()).toEqual({
      steps: 2,
      tokens: 900,
      elapsedMs: 4999,
      limits: { maxStepsPerTurn: 3, maxTokensPerTurn: 1000, maxTurnDurationMs: 5000 },
    });
  });

  it('步数超限 → BudgetStop(max_steps)', () => {
    const budget = new TurnBudget({ maxStepsPerTurn: 3, maxTokensPerTurn: 1000, maxTurnDurationMs: 5000 });

    budget.start();
    for (let i = 0; i < 3; i++) {
      budget.countStep();
      budget.guard();
    }
    budget.countStep();
    expect(() => budget.guard()).toThrow(BudgetStop);
    try {
      budget.guard();
      expect.unreachable('guard should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetStop);
      const stop = err as BudgetStop;
      expect(stop.reason).toBe('max_steps');
    }
  });

  it('token 超限 → BudgetStop(budget)', () => {
    const budget = new TurnBudget({ maxStepsPerTurn: 3, maxTokensPerTurn: 1000, maxTurnDurationMs: 5000 });

    budget.start();
    budget.countStep();
    budget.addUsage(usage(600, 300)); // 900
    budget.guard(); // 未到 1000
    budget.addUsage(usage(100, 50)); // 1050
    expect(() => budget.guard()).toThrow(BudgetStop);
    try {
      budget.guard();
      expect.unreachable('guard should have thrown');
    } catch (err) {
      expect((err as BudgetStop).reason).toBe('budget');
    }
  });

  it('时长超限 → BudgetStop(budget)', () => {
    const clock = new FakeClock();
    const budget = new TurnBudget(
      { maxStepsPerTurn: 40, maxTokensPerTurn: 500_000, maxTurnDurationMs: 5000 },
      clock,
    );

    budget.start();
    budget.countStep();
    clock.advance(4999);
    budget.guard(); // 未到
    clock.advance(1); // 恰好 5000
    expect(() => budget.guard()).toThrow(BudgetStop);
    try {
      budget.guard();
      expect.unreachable('guard should have thrown');
    } catch (err) {
      expect((err as BudgetStop).reason).toBe('budget');
    }
  });

  it('start() 重置全部计数', () => {
    const clock = new FakeClock();
    const budget = new TurnBudget(
      { maxStepsPerTurn: 1, maxTokensPerTurn: 100, maxTurnDurationMs: 1000 },
      clock,
    );

    budget.start();
    budget.countStep();
    budget.countStep(); // 超步数
    budget.addUsage(usage(999, 999));
    clock.advance(999_999);
    expect(() => budget.guard()).toThrow(BudgetStop);

    budget.start();
    budget.countStep();
    budget.guard(); // 重置后不再抛
    expect(budget.snapshot()).toEqual({
      steps: 1,
      tokens: 0,
      elapsedMs: 0,
      limits: { maxStepsPerTurn: 1, maxTokensPerTurn: 100, maxTurnDurationMs: 1000 },
    });
  });

  it('未 start() 时只检查步数与 token（无时长基准）', () => {
    const budget = new TurnBudget({ maxStepsPerTurn: 1, maxTokensPerTurn: 100, maxTurnDurationMs: 0 });

    budget.countStep();
    budget.guard(); // 1 <= 1，不抛
    budget.countStep();
    expect(() => budget.guard()).toThrow(BudgetStop);
    expect(budget.snapshot().elapsedMs).toBe(0);
  });
});
