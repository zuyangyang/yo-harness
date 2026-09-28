/**
 * 按角色 / 模型统计 token 用量。
 * 每次 LLM 调用后由 agent loop 上报，CLI 状态栏展示。
 */
import type { ModelRole, RoleUsage } from '../types/router.js';

export class CostTracker {
  private readonly records: RoleUsage[] = [];

  record(usage: RoleUsage): void {
    this.records.push(usage);
  }

  /** 按角色汇总 */
  summaryByRole(): Map<ModelRole, { inputTokens: number; outputTokens: number; callCount: number }> {
    const map = new Map<ModelRole, { inputTokens: number; outputTokens: number; callCount: number }>();
    for (const r of this.records) {
      const entry = map.get(r.role) ?? { inputTokens: 0, outputTokens: 0, callCount: 0 };
      entry.inputTokens += r.inputTokens;
      entry.outputTokens += r.outputTokens;
      entry.callCount++;
      map.set(r.role, entry);
    }
    return map;
  }

  /** 总计 */
  total(): { inputTokens: number; outputTokens: number } {
    return this.records.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
  }

  /** 重置（每个 turn 开始时调用） */
  reset(): void {
    this.records.length = 0;
  }
}
