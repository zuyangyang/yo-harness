/**
 * LocalProvider：本地子进程沙箱。
 *
 * 直接在本机执行命令和文件操作，适用于单租户模式或受信环境。
 * 复用 Phase 1-3 的 spawn 逻辑（进程组 kill、超时、输出截断）。
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

import type {
  SandboxProvider,
  ExecOptions,
  ExecResult,
  SandboxStatus,
} from '@yo-harness/core/types/sandbox.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_CAP = 10 * 1024;
const KILL_GRACE_MS = 1_000;

export class LocalProvider implements SandboxProvider {
  private status: SandboxStatus = 'ready';

  constructor(private readonly cwd: string) {}

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = opts.cwd ? path.resolve(this.cwd, opts.cwd) : this.cwd;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cap = opts.maxOutputBytes ?? DEFAULT_OUTPUT_CAP;

    return new Promise<ExecResult>((resolve) => {
      const stdout = new ByteCollector(cap);
      const stderr = new ByteCollector(cap);
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(command, {
        shell: true,
        cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const killTree = (sig: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        if (process.platform === 'win32') {
          child.kill(sig);
          return;
        }
        try {
          process.kill(-child.pid, sig);
        } catch {
          child.kill(sig);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      }, timeoutMs);

      const finish = (result: ExecResult): void => {
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (err) => {
        finish({ exitCode: 1, stdout: '', stderr: err.message, timedOut: false });
      });

      child.on('close', (code) => {
        finish({
          exitCode: code ?? 1,
          stdout: stdout.text(),
          stderr: stderr.text(),
          timedOut,
          stdoutTruncated: stdout.isTruncated,
          stderrTruncated: stderr.isTruncated,
        });
      });
    });
  }

  async readFile(filePath: string): Promise<Buffer> {
    const abs = path.resolve(this.cwd, filePath);
    return fsp.readFile(abs);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const abs = path.resolve(this.cwd, filePath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }

  async listDir(dirPath: string): Promise<Dirent[]> {
    const abs = path.resolve(this.cwd, dirPath);
    return fsp.readdir(abs, { withFileTypes: true });
  }

  getStatus(): SandboxStatus {
    return this.status;
  }

  destroy(): Promise<void> {
    this.status = 'stopped';
    return Promise.resolve();
  }
}

class ByteCollector {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  private readonly cap: number;
  private overflow = false;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(chunk: Buffer): void {
    if (this.total >= this.cap) {
      this.overflow = true;
      return;
    }
    const keep = this.cap - this.total;
    if (chunk.length <= keep) {
      this.chunks.push(chunk);
      this.total += chunk.length;
    } else {
      this.chunks.push(chunk.subarray(0, keep));
      this.total = this.cap;
      this.overflow = true;
    }
  }

  get isTruncated(): boolean {
    return this.overflow;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
