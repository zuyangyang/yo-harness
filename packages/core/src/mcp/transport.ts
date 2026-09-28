/**
 * stdio 传输层：管理子进程 + JSON-RPC 消息收发。
 *
 * 职责边界：只管通信（发请求、收响应、处理通知），
 * 不知道 MCP 协议语义（initialize / tools/list 等）。
 *
 * stdout 按 \n 分割行（MCP 规定每条 JSON-RPC 消息一行 + 换行符）。
 * stderr 输出全部转发到 logger.debug。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import type { Logger } from '../types/common.js';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, McpServerConfig } from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 3_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class StdioTransport {
  private process: ChildProcess | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';

  constructor(
    private readonly config: McpServerConfig,
    private readonly logger: Logger,
  ) {}

  /** 启动子进程 */
  start(): void {
    const env = this.config.env !== undefined
      ? { ...process.env, ...this.config.env }
      : process.env;

    this.process = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.process.stdout?.on('data', (data: Buffer) => this.onStdout(data));
    this.process.stderr?.on('data', (data: Buffer) => this.onStderr(data));

    this.process.on('exit', (code, signal) => {
      this.logger.debug(`MCP process exited: code=${code} signal=${signal}`);
      this.rejectAllPending(new Error(`MCP process exited: code=${code} signal=${signal}`));
      this.process = null;
    });

    this.process.on('error', (err) => {
      this.logger.warn(`MCP process error: ${String(err)}`);
      this.rejectAllPending(err);
      this.process = null;
    });
  }

  /** 发送 JSON-RPC 请求，等待响应（超时 reject） */
  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.process === null) {
      throw new Error('transport not started');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const timeout = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`request ${method} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.writeLine(JSON.stringify(request));
    });
  }

  /** 发送通知（无响应） */
  notify(method: string, params?: Record<string, unknown>): void {
    if (this.process === null) return;

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.writeLine(JSON.stringify(notification));
  }

  /** 优雅关闭：SIGTERM → 等 3s → SIGKILL */
  async stop(): Promise<void> {
    if (this.process === null) return;

    const proc = this.process;
    this.process = null;

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, STOP_GRACE_MS);

      proc.on('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  /** 是否存活 */
  get alive(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  private writeLine(line: string): void {
    this.process?.stdin?.write(line + '\n');
  }

  private onStdout(data: Buffer): void {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.handleMessage(trimmed);
    }
  }

  private onStderr(data: Buffer): void {
    this.logger.debug(`[mcp stderr] ${data.toString().trimEnd()}`);
  }

  private handleMessage(raw: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(raw) as JsonRpcResponse;
    } catch (err) {
      this.logger.warn(`MCP invalid JSON: ${String(err)}`);
      return;
    }

    if (typeof parsed.id !== 'number') return;

    const pending = this.pendingRequests.get(parsed.id);
    if (pending === undefined) return;

    this.pendingRequests.delete(parsed.id);
    clearTimeout(pending.timer);

    if (parsed.error !== undefined) {
      pending.reject(new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`));
    } else {
      pending.resolve(parsed.result);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }
}

export { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS };
