/**
 * 后台任务类型定义。
 *
 * 后台任务 = 无头 AgentLoop：没有 Ink UI，没有用户交互，跑完即止。
 * 任务状态机：pending → running → completed | failed | cancelled。
 * 事件流与交互式会话共用 EventStore（按 sessionId 隔离），
 * CLI 通过 `yo task <id>` 重放事件流渲染结果。
 */

export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTask {
  id: string;
  sessionId: string;
  /** 用户提交的任务描述（首条 user_input） */
  description: string;
  status: BackgroundTaskStatus;
  /** 运行任务的进程 ID（daemon 模式下填充） */
  pid: number | null;
  /** 任务结束原因（completed/failed/cancelled 时填充） */
  endReason: 'end_turn' | 'budget' | 'error' | 'cancelled' | null;
  /** 任务完成时间（ISO 8601） */
  completedAt: string | null;
  /** 最终摘要（模型输出的最后一段文本） */
  summary: string | null;
  /** 错误信息（failed 时填充） */
  errorMessage: string | null;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 任务运行目录 */
  cwd: string;
  /** 使用的模型（provider/model 格式） */
  model: string;
}

export interface CreateTaskInput {
  description: string;
  cwd: string;
  model: string;
}
