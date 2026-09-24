/**
 * Provider 错误分类：SDK 抛出的原始错误 → 平台错误体系。
 *
 * - 408 / 429 / 5xx / 连接类错误 → TransientError（网关可退避重试）
 * - 400 / 422 → ValidationError（请求本身有误，不重试）
 * - 其余 4xx（401/403/404…）→ FatalError
 * - 无法识别 → FatalError 包裹（保守终止，绝不误重试）
 *
 * 刻意用鸭子类型读 status / name，不依赖具体 SDK 的错误类
 * （两个 SDK 的 APIError 在测试里难以构造，且结构随版本漂移）。
 */
import { AppError, FatalError, TransientError, ValidationError } from '../types/errors.js';

export function classifyProviderError(err: unknown): Error {
  if (err instanceof AppError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  const status = readStatus(err);

  if (status !== undefined) {
    if (status === 408 || status === 429 || status >= 500) {
      return new TransientError(`provider http ${status}: ${message}`);
    }
    if (status === 400 || status === 422) {
      return new ValidationError(`provider http ${status}: ${message}`);
    }
    return new FatalError(`provider http ${status}: ${message}`);
  }

  if (isConnectionError(err)) {
    return new TransientError(`provider network failure: ${message}`);
  }
  return new FatalError(`provider failure: ${message}`, { cause: err });
}

function readStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

function isConnectionError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return name.includes('Connection') || name.includes('Timeout');
}
