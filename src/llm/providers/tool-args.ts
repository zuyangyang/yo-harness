/**
 * 工具参数 JSON 的统一收敛（anthropic / openai-compat 共用）。
 *
 * - 流式 input_json_delta / function.arguments 拼出的 JSON 可能是空串（无参工具）
 *   → 收敛为 {}；
 * - 畸形 JSON → ValidationError（重试同样的请求大概率得到同样的畸形输出，
 *   属不可重试）；
 * - 合法但非对象（数组 / 数字 / null）→ 宽容收敛为 {}，不打断对话。
 */
import { ValidationError } from '../../types/errors.js';

/** 把 Provider 侧的 arguments JSON 字符串解析为 Record */
export function parseToolArgs(json: string): Record<string, unknown> {
  if (json.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ValidationError(`provider returned malformed tool arguments: ${json}`);
  }
  return asRecord(parsed);
}

/** 已解析的 unknown input（anthropic 非流式）→ Record */
export function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
