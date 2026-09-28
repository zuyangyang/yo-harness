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

/**
 * 工具执行的结构化错误（Phase 2）。
 *
 * 工具的 run() 返回 ToolResult(ok=false, content=formatToolError(...))，
 * loop 据此决定是否重试（transient → 重试，parameter → 反馈模型自纠，fatal → 终止）。
 */
export interface ToolError {
  kind: 'transient' | 'parameter' | 'fatal';
  message: string;
  suggestion?: string;
  retryCount?: number;
  validationDetails?: string;
}

/** 格式化为模型可读的错误文本（嵌入 ToolResult.content） */
export function formatToolError(err: ToolError): string {
  const parts = [`[${err.kind.toUpperCase()}] ${err.message}`];
  if (err.suggestion) parts.push(`Suggestion: ${err.suggestion}`);
  if (err.retryCount !== undefined) parts.push(`Retries: ${err.retryCount}/3`);
  if (err.validationDetails) parts.push(`Details: ${err.validationDetails}`);
  return parts.join('\n');
}

/** 从工具结果文本中检测是否为瞬态错误（供 loop 重试逻辑使用） */
export function isTransientError(content: string): boolean {
  return content.startsWith('[TRANSIENT]');
}
