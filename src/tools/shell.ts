/**
 * 内置 shell 工具：spawn(shell:true, cwd 限定) + 超时杀进程组。
 *
 * 安全要点：
 * - stdin 显式 ignore：命令读 stdin 立即得到 EOF，不会挂死等待；
 * - 超时先 SIGTERM 进程组（detached + kill(-pid)，避免 shell 的
 *   孙进程存活），1s 宽限后 SIGKILL；
 * - stdout / stderr 各截 10KB，防止巨量输出撑爆上下文；
 * - run() 永不 throw。
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';

import { formatToolError } from '../types/errors.js';
import type { Tool, ToolResult } from '../types/tools.js';

/** 默认超时 */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** timeoutMs 上限（5 分钟） */
export const MAX_TIMEOUT_MS = 300_000;
const OUTPUT_CAP_BYTES = 10 * 1024;
const KILL_GRACE_MS = 1_000;

export const ShellArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

/** 收集输出到固定字节上限，超出的丢弃但计数 */
class ByteCollector {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  private dropped = 0;

  push(chunk: Buffer): void {
    if (this.total >= OUTPUT_CAP_BYTES) {
      this.dropped += chunk.length;
      return;
    }
    const keep = OUTPUT_CAP_BYTES - this.total;
    if (chunk.length <= keep) {
      this.chunks.push(chunk);
      this.total += chunk.length;
    } else {
      this.chunks.push(chunk.subarray(0, keep));
      this.dropped += chunk.length - keep;
      this.total = OUTPUT_CAP_BYTES;
    }
  }

  text(): string {
    let s = Buffer.concat(this.chunks).toString('utf8');
    if (s.endsWith('�')) s = s.slice(0, -1); // 截断切在多字节字符中间
    return s;
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }
}

function formatResult(
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: ByteCollector,
  stderr: ByteCollector,
  timedOut: boolean,
  timeoutMs: number,
): ToolResult {
  const outText = stdout.text() + (stdout.truncated ? '\n[stdout truncated at 10KB]' : '');
  const errText = stderr.text() + (stderr.truncated ? '\n[stderr truncated at 10KB]' : '');

  // 超时视为瞬态错误，可重试
  if (timedOut) {
    return {
      ok: false,
      content: formatToolError({
        kind: 'transient',
        message: `shell timed out after ${timeoutMs}ms (killed)`,
        suggestion: 'The command took too long. Consider breaking it into smaller steps or increasing timeoutMs.',
      }),
    };
  }

  // OOM 检测（SIGKILL + 特定 stderr 模式）
  const isOOM =
    signal === 'SIGKILL' &&
    (errText.includes('out of memory') ||
      errText.includes('OOM') ||
      errText.includes('Cannot allocate memory'));
  if (isOOM) {
    return {
      ok: false,
      content: formatToolError({
        kind: 'transient',
        message: 'shell killed due to out-of-memory (OOM)',
        suggestion: 'The process used too much memory. Try processing data in smaller chunks.',
      }),
    };
  }

  const head = `exit code: ${code ?? 'unknown'}${signal !== null ? ` (signal: ${signal})` : ''}`;
  return {
    ok: code === 0,
    content: `${head}\n--- stdout ---\n${outText}\n--- stderr ---\n${errText}`,
  };
}

export const shellTool: Tool = {
  name: 'shell',
  description: [
    'Run a shell command in the workspace via /bin/sh (single command line, pipes and && are allowed).',
    'Use for builds, tests, git, and other CLI work; the command runs with the workspace as its working directory.',
    '`timeoutMs` bounds the run (default 60s, max 300s) — the process group is killed on expiry.',
    'stdout and stderr are returned separately, each capped at 10KB.',
    'Non-zero exit codes report as failures with the code and captured output.',
  ].join(' '),
  risk: 'danger',
  inputSchema: ShellArgsSchema,
  async run(raw, ctx) {
    const parsed = ShellArgsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        content: `invalid arguments for shell: ${z.prettifyError(parsed.error)}`,
      };
    }
    const { command } = parsed.data;
    const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return await new Promise<ToolResult>((resolve) => {
      const stdout = new ByteCollector();
      const stderr = new ByteCollector();
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(command, {
        shell: true,
        cwd: ctx.cwd,
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
          process.kill(-child.pid, sig); // 杀整个进程组（含孙进程）
        } catch {
          child.kill(sig); // 组已消失则退回单进程
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      }, timeoutMs);

      const finish = (result: ToolResult): void => {
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (err) => {
        finish({ ok: false, content: `shell failed: ${err.message}` });
      });

      child.on('close', (code, signal) => {
        finish(formatResult(code, signal, stdout, stderr, timedOut, timeoutMs));
      });
    });
  },
};
