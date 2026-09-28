/**
 * Daemon API 客户端：CLI 侧 HTTP 调用封装。
 *
 * daemon 进程监听 Unix socket（~/.yo-harness/daemon.sock），CLI 通过本客户端
 * 提交任务、查询状态、取消任务。所有方法返回 Promise，网络错误 / daemon 未启动
 * 统一抛 FatalError（CLI 层捕获后给用户友好提示）。
 *
 * 超时约定：默认 5 秒（daemon 应在本地 socket 通信，延迟极低；超时通常意味着
 * daemon 卡死或未启动）。
 */
import { FatalError } from '../types/errors.js';

export interface StartTaskRequest {
  prompt: string;
  cwd: string;
  model: string;
}

export interface StartTaskResponse {
  taskId: string;
  sessionId: string;
}

export interface TaskInfo {
  id: string;
  sessionId: string;
  description: string;
  status: string;
  endReason: string | null;
  completedAt: string | null;
  summary: string | null;
  errorMessage: string | null;
  createdAt: string;
  cwd: string;
  model: string;
}

export interface DaemonApiClientConfig {
  socketPath: string;
  timeoutMs?: number;
}

export class DaemonApiClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(config: DaemonApiClientConfig) {
    this.socketPath = config.socketPath;
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  async startTask(req: StartTaskRequest): Promise<StartTaskResponse> {
    return this.request<StartTaskResponse>('POST', '/tasks/start', req);
  }

  async listTasks(limit = 20): Promise<TaskInfo[]> {
    return this.request<TaskInfo[]>('GET', `/tasks?limit=${limit}`);
  }

  async getTask(taskId: string): Promise<TaskInfo> {
    return this.request<TaskInfo>('GET', `/tasks/${encodeURIComponent(taskId)}`);
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.request<void>('POST', `/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  async stopDaemon(): Promise<void> {
    await this.request<void>('POST', '/daemon/stop');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `http://localhost${path}`;
      const init: RequestInit = {
        method,
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { 'Content-Type': 'application/json' };
      }
      const response = await fetch(url, init);

      if (!response.ok) {
        const errorText = await response.text();
        throw new FatalError(`daemon API error: ${response.status} ${response.statusText}\n  ${errorText}`);
      }

      const text = await response.text();
      if (text.length === 0) return undefined as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof FatalError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new FatalError(`daemon request timeout after ${this.timeoutMs}ms`);
      }
      throw new FatalError(`daemon connection failed: ${String(err)}\n  is the daemon running?`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
