/**
 * 内置文件系统工具：read_file / write_file / list_dir。
 *
 * 共同约束：
 * - 所有路径经 resolveInWorkspace 校验，必须落在会话 cwd 内；
 * - run() 永不 throw：zod 校验失败 / 路径逃逸 / 文件系统错误
 *   一律转成 ToolResult(ok=false) + 可读修复提示。
 */
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { Tool, ToolResult } from '../types/tools.js';
import { formatToolError } from '../types/errors.js';
import { errorMessage } from '../utils/errors.js';
import { resolveInWorkspace } from '../utils/paths.js';

/** read_file 读取上限：200KB，超出截断并附提示 */
export const READ_MAX_BYTES = 200 * 1024;
/** list_dir 条目上限 */
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

/** 截断可能切在多字节字符中间，留下一个 U+FFFD 替换字符——去掉它 */
function stripDanglingReplacement(text: string): string {
  return text.endsWith('�') ? text.slice(0, -1) : text;
}

/** 大文件只读前 READ_MAX_BYTES 字节，避免整文件进内存 */
async function readCapped(abs: string, size: number): Promise<string> {
  const len = Math.min(size, READ_MAX_BYTES);
  const handle = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, 0);
    return stripDanglingReplacement(buf.toString('utf8'));
  } finally {
    await handle.close();
  }
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
      const abs = resolveInWorkspace(ctx.cwd, parsed.data.path);
      const info = await stat(abs);
      if (!info.isFile()) {
        return {
          ok: false,
          content: `read_file: not a regular file: ${parsed.data.path}`,
        };
      }
      const text = await readCapped(abs, info.size);
      if (info.size > READ_MAX_BYTES) {
        return {
          ok: true,
          content: `${text}\n\n[truncated: file is ${info.size} bytes, showing the first ${READ_MAX_BYTES} bytes (lines 1-${countLines(text)})]`,
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
      const abs = resolveInWorkspace(ctx.cwd, relPath);

      // Phase 2: 写前快照 —— 如果 agent-loop 注入了 checkpoint 回调
      if (ctx.snapshotBeforeWrite !== undefined) {
        await ctx.snapshotBeforeWrite(relPath);
      }

      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, parsed.data.content, 'utf8');
      const bytes = Buffer.byteLength(parsed.data.content, 'utf8');
      return {
        ok: true,
        content: `wrote ${bytes} bytes to ${path.relative(ctx.cwd, abs)}`,
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
      const abs = resolveInWorkspace(ctx.cwd, parsed.data.path ?? '.');
      const info = await stat(abs);
      if (!info.isDirectory()) {
        return { ok: false, content: `list_dir: not a directory: ${parsed.data.path ?? '.'}` };
      }
      const entries = await readdir(abs, { withFileTypes: true });
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

  // 瞬态 I/O 错误：磁盘满、硬件 I/O 错误、资源暂时不可用
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
