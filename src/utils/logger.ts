/**
 * Logger 端口的默认实现（types/common.ts 的注释指向这里）。
 *
 * 两个刻意决定：
 * - 全部输出走 stderr：交互模式下 ink 独占 stdout 做 TUI 渲染，任何
 *   穿插的 stdout 写入都会打花界面；而告警与错误必须仍然可见；
 * - 级别由 YO_LOG 控制（§5.5），宽松解析——日志配置错误不该把程序搞挂。
 *
 * sink 可注入：单测捕获输出，不 spy 全局 process.stderr。
 */
import type { Logger } from '../types/common.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.MAX_SAFE_INTEGER,
};

/** 一行日志的最终去向；默认 stderr + 换行 */
export type LogSink = (line: string) => void;

function stderrSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** YO_LOG 宽松解析：空白 / 未知值一律回落 info */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  return value !== undefined && value in LEVEL_WEIGHT ? (value as LogLevel) : 'info';
}

/** 循环引用等 stringify 失败时降级 String()，日志永远不能抛 */
function formatData(data: unknown): string {
  try {
    return JSON.stringify(data) ?? 'undefined';
  } catch {
    return String(data);
  }
}

export function createLogger(level: LogLevel = 'info', sink: LogSink = stderrSink): Logger {
  const weight = LEVEL_WEIGHT[level];
  const emit = (lv: LogLevel, message: string, data?: unknown): void => {
    if (LEVEL_WEIGHT[lv] < weight) return;
    const suffix = data === undefined ? '' : ` ${formatData(data)}`;
    sink(`yo ${lv} ${message}${suffix}`);
  };
  return {
    debug: (message, data) => emit('debug', message, data),
    info: (message, data) => emit('info', message, data),
    warn: (message, data) => emit('warn', message, data),
    error: (message, data) => emit('error', message, data),
  };
}
