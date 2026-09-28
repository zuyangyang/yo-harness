/**
 * 内置 shell 工具：通过 SandboxProvider 执行命令。
 *
 * 安全要点：
 * - 命令在沙箱内执行（本地子进程或 Docker 容器）
 * - 超时 + 输出截断由 SandboxProvider 处理
 * - run() 永不 throw。
 */
import { z } from 'zod';

import { formatToolError } from '../types/errors.js';
import type { Tool, ToolResult } from '../types/tools.js';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 300_000;

export const ShellArgsSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
});

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

    try {
      const result = await ctx.sandbox.exec(command, { timeoutMs });

      if (result.timedOut) {
        return {
          ok: false,
          content: formatToolError({
            kind: 'transient',
            message: `shell timed out after ${timeoutMs}ms (killed)`,
            suggestion: 'The command took too long. Consider breaking it into smaller steps or increasing timeoutMs.',
          }),
        };
      }

      const isOOM =
        result.exitCode === 137 &&
        (result.stderr.includes('out of memory') ||
          result.stderr.includes('OOM') ||
          result.stderr.includes('Cannot allocate memory'));
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

      const head = `exit code: ${result.exitCode}`;
      const stdoutText = result.stdoutTruncated
        ? `${result.stdout}\n[stdout truncated at 10KB]`
        : result.stdout;
      const stderrText = result.stderrTruncated
        ? `${result.stderr}\n[stderr truncated at 10KB]`
        : result.stderr;
      return {
        ok: result.exitCode === 0,
        content: `${head}\n--- stdout ---\n${stdoutText}\n--- stderr ---\n${stderrText}`,
      };
    } catch (err) {
      return { ok: false, content: `shell failed: ${String(err)}` };
    }
  },
};
