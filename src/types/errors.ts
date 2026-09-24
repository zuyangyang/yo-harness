/**
 * 系统级错误分类。
 *
 * 约定：
 * - 工具执行层【永不 throw】，统一返回 ToolResult（ok=false + 错误说明）；
 *   本文件只用于内核 / Provider / 存储等系统级边界。
 * - TransientError：可重试（429 / 5xx / 网络抖动），网关负责退避重试；
 * - ValidationError：不可重试（参数 / 配置错误），直接上抛；
 * - FatalError / BudgetStop：终止当前 turn，进程不崩。
 */

/** turn 熔断原因（映射到 TurnEndReason 的子集） */
export type StopReason = 'max_steps' | 'budget' | 'interrupted';

export class AppError extends Error {
  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 可重试错误：网关以指数退避重试（1s/2s/4s） */
export class TransientError extends AppError {}

/** 不可重试错误：请求或配置本身有误 */
export class ValidationError extends AppError {}

/** 不可恢复错误：终止当前 turn */
export class FatalError extends AppError {}

/** 熔断信号：由 TurnBudget / 中断逻辑抛出，AgentLoop 捕获后优雅收尾 */
export class BudgetStop extends FatalError {
  constructor(public readonly reason: StopReason) {
    super(`turn stopped: ${reason}`);
  }
}
