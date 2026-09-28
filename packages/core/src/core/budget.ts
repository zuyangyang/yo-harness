/**
 * Turn 预算：步数 / token / 时长三重熔断（§6.6）。
 *
 * 每 turn 开始 start() 重置并计时；循环每步 countStep()、每次 LLM
 * 响应后 addUsage()；下一次 LLM 调用前 guard()，超限抛 BudgetStop
 * （types/errors.ts），AgentLoop 捕获后以对应 TurnEndReason 优雅收尾。
 * 时钟可注入，单测用假时钟推进。
 */
import { BudgetStop } from '../types/errors.js';
import type { Usage } from '../types/events.js';

export interface BudgetLimits {
  maxStepsPerTurn: number;
  maxTokensPerTurn: number;
  maxTurnDurationMs: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxStepsPerTurn: 40,
  maxTokensPerTurn: 500_000,
  maxTurnDurationMs: 10 * 60 * 1000,
};

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface BudgetSnapshot {
  steps: number;
  tokens: number;
  elapsedMs: number;
  limits: BudgetLimits;
}

export class TurnBudget {
  private steps = 0;
  private tokens = 0;
  private startedAt: number | undefined;

  constructor(
    private readonly limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
    private readonly clock: Clock = systemClock,
  ) {}

  /** 每 turn 开始时重置并计时 */
  start(): void {
    this.steps = 0;
    this.tokens = 0;
    this.startedAt = this.clock.now();
  }

  /** 每次循环迭代（= 一次 LLM 调用）开始时计数 */
  countStep(): void {
    this.steps += 1;
  }

  /** 累计真实 usage（网关每次响应后回报；inputTokens + outputTokens） */
  addUsage(usage: Usage): void {
    this.tokens += usage.inputTokens + usage.outputTokens;
  }

  /**
   * LLM 调用前的熔断检查，超限抛 BudgetStop：
   * steps 超限 → 'max_steps'；token / 时长超限 → 'budget'。
   * 未 start() 时无时长基准，只检查步数与 token。
   */
  guard(): void {
    if (this.steps > this.limits.maxStepsPerTurn) {
      throw new BudgetStop('max_steps');
    }
    if (this.tokens >= this.limits.maxTokensPerTurn) {
      throw new BudgetStop('budget');
    }
    if (
      this.startedAt !== undefined &&
      this.clock.now() - this.startedAt >= this.limits.maxTurnDurationMs
    ) {
      throw new BudgetStop('budget');
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      steps: this.steps,
      tokens: this.tokens,
      elapsedMs: this.startedAt === undefined ? 0 : this.clock.now() - this.startedAt,
      limits: this.limits,
    };
  }
}
