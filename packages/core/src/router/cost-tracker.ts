/**
 * 按角色 / 模型统计 token 用量与成本。
 * 每次 LLM 调用后由 agent loop 上报，CLI 状态栏展示。
 */
import { estimateCost } from '../types/pricing.js';
import type { ModelPrice } from '../types/pricing.js';
import type { ModelRole, RoleUsage } from '../types/router.js';

export interface RoleSummary {
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  /** 累计成本（USD）；所有调用均无价格时为 undefined */
  cost: number | undefined;
}

export class CostTracker {
  private readonly records: RoleUsage[] = [];

  /** price 缺省表示该调用无价格（fake / 未登记模型），只累计 token */
  record(usage: RoleUsage, price?: ModelPrice): void {
    const cost = estimateCost(
      { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      price,
    );
    this.records.push({ ...usage, ...(cost !== undefined ? { cost } : {}) });
  }

  /** 按角色汇总 */
  summaryByRole(): Map<ModelRole, RoleSummary> {
    const map = new Map<ModelRole, RoleSummary>();
    for (const r of this.records) {
      const entry = map.get(r.role) ?? { inputTokens: 0, outputTokens: 0, callCount: 0, cost: undefined };
      entry.inputTokens += r.inputTokens;
      entry.outputTokens += r.outputTokens;
      entry.callCount++;
      if (r.cost !== undefined) entry.cost = (entry.cost ?? 0) + r.cost;
      map.set(r.role, entry);
    }
    return map;
  }

  /** 总计 */
  total(): { inputTokens: number; outputTokens: number; cost: number | undefined } {
    let inputTokens = 0;
    let outputTokens = 0;
    let cost: number | undefined;
    for (const r of this.records) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      if (r.cost !== undefined) cost = (cost ?? 0) + r.cost;
    }
    return { inputTokens, outputTokens, cost };
  }

  /** 重置（每个 turn 开始时调用） */
  reset(): void {
    this.records.length = 0;
  }
}
