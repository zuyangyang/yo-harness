/**
 * 定时任务调度器内部类型。
 */
import type { ScheduledTask } from '@yo-harness/core/core/ports.js';
import type { TurnEndReason } from '@yo-harness/core/types/events.js';
import type { Logger } from '@yo-harness/core/types/common.js';

import type { StorageBackend } from '../storage/interface.js';
import type { SessionManager } from '../session-manager.js';
import type { WebSocketHub } from '../ws/hub.js';

export interface SchedulerDeps {
  storage: StorageBackend;
  sessionManager: SessionManager;
  wsHub?: WebSocketHub;
  logger: Logger;
  /** schedule 未指定 cwd 时使用的默认工作目录 */
  defaultCwd: string;
  /** 解析全局默认模型标签，形如 provider/model */
  resolveDefaultModel: () => Promise<string>;
  /** 扫描间隔，缺省 30s */
  tickMs?: number;
  /** 全局并发运行上限，缺省 3 */
  maxConcurrentRuns?: number;
  /** 连续失败达到该值自动停用；0/缺省 = 5 */
  maxConsecutiveFailures?: number;
}

export type RunStatus = 'completed' | 'failed' | 'cancelled';

export interface RunOutcome {
  runId: string;
  sessionId: string;
  status: RunStatus;
  summary: string | null;
  reason: TurnEndReason;
}

export type { ScheduledTask };
