/**
 * SandboxProvider 接口：工具执行的沙箱抽象（core 层定义，server 层实现）。
 *
 * 所有 I/O 密集型工具（shell、fs）通过 SandboxProvider 执行，
 * 服务端可选择 LocalProvider（本地子进程）或 DockerProvider（容器隔离）。
 */
import type { Dirent } from 'node:fs';

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type SandboxStatus = 'starting' | 'ready' | 'busy' | 'stopped';

export interface SandboxProvider {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer | string): Promise<void>;
  listDir(path: string): Promise<Dirent[]>;
  getStatus(): SandboxStatus;
  destroy(): Promise<void>;
}
