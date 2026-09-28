/**
 * 内置文件系统工具：read_file / write_file / list_dir。
 *
 * 通过 SandboxProvider 执行所有 I/O，支持本地和 Docker 沙箱。
 * 共同约束：
 * - 所有路径经 resolveInWorkspace 校验，必须落在会话 cwd 内；
 * - run() 永不 throw。
 */
import path from 'node:path';
import { z } from 'zod';

import type { Tool, ToolResult } from '../types/tools.js';
import { formatToolError } from '../types/errors.js';
import { errorMessage } from '../utils/errors.js';
import { resolveInWorkspace } from '../utils/paths.js';

export const READ_MAX_BYTES = 200 * 1024;
export const LIST_MAX_ENTRIES = 500;

export const ReadFileArgsSchema = z.object({
  path: z.string().min(1),
});
export const WriteFileArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export const ListDirArgsSchema = z.object({
  path: z.string().min(1).optional(),
});

function stripDanglingReplacement(text: string): string {
  return text.endsWith('�') ? text.slice(0, -1) : text;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description: [
    'Read a UTF-8 text file from the workspace.',
    'Use for source code, configs, and notes; `path` is relative to the workspace root.',
    'Returns content up to 200KB — larger files are truncated with a notice showing the covered line range.',
    'Use list_dir first when unsure about the layout.',
    'Fails when the path does not exist, is a directory, or escapes the workspace.',
  ].join(' '),
  risk: 'read',
  inputSchema: ReadFileArgsSchema,
  async run(raw, ctx) {
    const parsed = ReadFileArgsSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidArgs('read_file', parsed.error);
    }
    try {
      const relPath = parsed.data.path;
      resolveInWorkspace(ctx.cwd, relPath);

      const buf = await ctx.sandbox.readFile(relPath);
      let text = stripDanglingReplacement(buf.toString('utf8'));

      if (buf.length > READ_MAX_BYTES) {
        text = stripDanglingReplacement(buf.subarray(0, READ_MAX_BYTES).toString('utf8'));
        return {
          ok: true,
          content: `${text}\n\n[truncated: file is ${buf.length} bytes, showing the first ${READ_MAX_BYTES} bytes (lines 1-${countLines(text)})]`,
        };
      }
      return { ok: true, content: text };
    } catch (err) {
      return failed('read_file', err);
    }
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: [
    'Create or overwrite a UTF-8 text file in the workspace.',
    'Use for source code, configs, and notes; `path` is relative to the workspace root and must stay inside it.',
    'Parent directories are created automatically; `content` is written verbatim.',
    'Read the existing file first if you need to keep any of it — this tool overwrites without merging.',
    'Fails when the path escapes the workspace.',
  ].join(' '),
  risk: 'write',
  inputSchema: WriteFileArgsSchema,
  async run(raw, ctx) {
    const parsed = WriteFileArgsSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidArgs('write_file', parsed.error);
    }
    try {
      const relPath = parsed.data.path;
      resolveInWorkspace(ctx.cwd, relPath);

      if (ctx.snapshotBeforeWrite !== undefined) {
        await ctx.snapshotBeforeWrite(relPath);
      }

      await ctx.sandbox.writeFile(relPath, parsed.data.content);
      const bytes = Buffer.byteLength(parsed.data.content, 'utf8');
      return {
        ok: true,
        content: `wrote ${bytes} bytes to ${relPath}`,
      };
    } catch (err) {
      return failed('write_file', err);
    }
  },
};

export const listDirTool: Tool = {
  name: 'list_dir',
  description: [
    'List one directory level of the workspace.',
    'Use it to explore the project layout before reading or writing files;',
    '`path` is relative to the workspace root and defaults to the root itself.',
    'Entries are grouped (directories first, then files) and capped at 500 with a notice.',
    'Fails when the path does not exist, is a file, or escapes the workspace.',
  ].join(' '),
  risk: 'read',
  inputSchema: ListDirArgsSchema,
  async run(raw, ctx) {
    const parsed = ListDirArgsSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidArgs('list_dir', parsed.error);
    }
    try {
      const relPath = parsed.data.path ?? '.';
      resolveInWorkspace(ctx.cwd, relPath);

      const entries = await ctx.sandbox.listDir(relPath);
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      const dirs: string[] = [];
      const files: string[] = [];
      const others: string[] = [];
      for (const entry of entries) {
        if (dirs.length + files.length + others.length >= LIST_MAX_ENTRIES) break;
        if (entry.isDirectory()) dirs.push(`${entry.name}/`);
        else if (entry.isFile()) files.push(entry.name);
        else others.push(`${entry.name} (${entry.isSymbolicLink() ? 'symlink' : 'other'})`);
      }
      const shown = dirs.length + files.length + others.length;
      const hidden = entries.length - shown;

      const sections: string[] = [];
      if (dirs.length > 0) sections.push(`directories:\n${dirs.map((d) => `  ${d}`).join('\n')}`);
      if (files.length > 0) sections.push(`files:\n${files.map((f) => `  ${f}`).join('\n')}`);
      if (others.length > 0) sections.push(`other:\n${others.map((o) => `  ${o}`).join('\n')}`);
      if (hidden > 0) sections.push(`(${hidden} more entries not shown)`);

      const content = sections.length === 0 ? '(empty directory)' : sections.join('\n\n');
      return { ok: true, content, data: { entries: shown + hidden } };
    } catch (err) {
      return failed('list_dir', err);
    }
  },
};

function invalidArgs(toolName: string, error: z.ZodError): ToolResult {
  return { ok: false, content: `invalid arguments for ${toolName}: ${z.prettifyError(error)}` };
}

function failed(toolName: string, err: unknown): ToolResult {
  const msg = errorMessage(err);
  const code = (err as NodeJS.ErrnoException).code;

  if (code === 'EISDIR') {
    return { ok: false, content: `${toolName} failed: ${code} — not a regular file` };
  }

  const transientCodes = new Set(['EIO', 'ENOSPC', 'EAGAIN', 'EBUSY']);
  if (code !== undefined && transientCodes.has(code)) {
    return {
      ok: false,
      content: formatToolError({
        kind: 'transient',
        message: `${toolName} I/O error (${code}): ${msg}`,
        suggestion: 'This is a temporary system resource issue. The system will retry automatically.',
      }),
    };
  }

  return { ok: false, content: `${toolName} failed: ${msg}` };
}
