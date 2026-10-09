/**
 * token 估算与校准（§6.5）。
 *
 * CJK 感知估算：中日韩全角字符 ≈ 1 token/字，其余 ≈ 4 字符/token。
 * 只求稳定可复现（让省略决策可预测），不求 tokenizer 级精确；
 * 每次真实响应后用 usage.inputTokens 校准并 log 偏差，
 * 为 Phase 2 的压缩策略积累数据。
 */
import type { Logger } from '../types/common.js';
import type { Usage } from '../types/events.js';
import type { ChatMessage } from '../types/llm.js';

/** CJK / 全角 / 韩文近似集合（够用即可，不追求 Unicode 精确分类） */
const WIDE_CHAR = /[\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** 估算一段文本的 token 数（宽字符 1:1，其余 4:1） */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (WIDE_CHAR.test(ch)) wide += 1;
    else narrow += 1;
  }
  return Math.ceil(wide + narrow / 4);
}

/** 估算单条消息（assistant 的 toolCalls 以 JSON 序列化文本计） */
export function estimateMessageTokens(message: ChatMessage): number {
  switch (message.role) {
    case 'user':
      return estimateTokens(message.text);
    case 'assistant':
      return (
        estimateTokens(message.text) +
        (message.toolCalls === undefined ? 0 : estimateTokens(JSON.stringify(message.toolCalls)))
      );
    case 'tool':
      return estimateTokens(message.text);
  }
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * 真实响应后校准：对比估算与实际 inputTokens 并记录偏差。
 * 数据去 debug 日志（不进事件流），供 Phase 2 压缩调参。
 */
export function logTokenCalibration(
  logger: Logger,
  estimatedTokens: number,
  usage: Usage,
): void {
  if (estimatedTokens <= 0 || usage.inputTokens <= 0) return;
  const ratio = usage.inputTokens / estimatedTokens;
  logger.debug('token calibration', {
    estimated: estimatedTokens,
    actual: usage.inputTokens,
    ratio: Number(ratio.toFixed(2)),
  });
}

/**
 * 逐模型 token 估算校准器（§10.1）。
 *
 * 用 EMA 跟踪「实际 inputTokens / 估算 tokens」的比值，
 * 让预算决策（省略 / 丢弃）随真实偏差收敛。默认 ratio = 1.0（不校正）。
 * 进程级内存态，暂不持久化。
 */
export class TokenCalibrator {
  private readonly ratios = new Map<string, number>();
  /** EMA 平滑系数：越大越追新样本 */
  private readonly alpha: number;

  constructor(alpha = 0.3) {
    this.alpha = alpha;
  }

  /** 记录一次真实响应的估算偏差，EMA 更新该模型的 ratio */
  observe(provider: string, model: string, estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;
    const key = `${provider}/${model}`;
    const sample = actual / estimated;
    const prev = this.ratios.get(key) ?? 1;
    this.ratios.set(key, prev * (1 - this.alpha) + sample * this.alpha);
  }

  /** 该模型当前的校准系数（未观测过返回 1.0） */
  ratio(provider: string, model: string): number {
    return this.ratios.get(`${provider}/${model}`) ?? 1;
  }
}
