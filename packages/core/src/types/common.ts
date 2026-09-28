/**
 * 日志端口：utils/logger 提供实现。
 * 内核与工具只依赖此接口，便于注入与测试。
 */
export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}
