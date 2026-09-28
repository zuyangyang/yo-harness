/**
 * 路径约定 + 路径安全解析。
 *
 * resolveInWorkspace 是 write_file / shell / read_file 等工具的
 * 共同前提：任何模型给出的路径都必须落在会话 cwd 之内，
 * `..` 逃逸与 cwd 外的绝对路径直接拒绝（ValidationError）。
 *
 * 注意：这里做的是「词法」边界判定（基于 resolve 后的字符串前缀），
 * 不解析符号链接——经 symlink 指向 cwd 外的逃逸属于 Phase 2 的
 * realpath 硬化项，Phase 1 明确接受该限制（本地个人使用场景）。
 */
import { homedir } from 'node:os';
import path from 'node:path';

import { ValidationError } from '../types/errors.js';

/** 平台数据目录：`~/.yo-harness`，可用 YO_DATA_DIR 覆盖（测试 / 多实例） */
export function yoHome(): string {
  return process.env.YO_DATA_DIR ?? path.join(homedir(), '.yo-harness');
}

/**
 * 把（可能是相对的）目标路径解析为 cwd 内的绝对路径。
 *
 * - 相对路径以 cwd 为基准；
 * - 绝对路径必须已位于 cwd 之下；
 * - 任何形式的逃逸（`..` 穿越、cwd 外绝对路径、兄弟目录前缀）
 *   抛 ValidationError。
 *
 * 返回 normalize 后的绝对路径；cwd 本身合法（读取时由文件系统
 * 自行报 EISDIR 等，统一转为 ToolResult(ok=false)）。
 */
export function resolveInWorkspace(cwd: string, target: string): string {
  const base = path.resolve(cwd);
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);

  const rel = path.relative(base, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ValidationError(
      `path escapes the session workspace: "${target}" resolves to ${abs}, which is outside ${base}. Use paths relative to the workspace root.`,
    );
  }
  return abs;
}
