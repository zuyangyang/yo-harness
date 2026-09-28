/**
 * 分级压缩器：把超预算的上下文压缩到可接受范围。
 *
 * 压缩分级：
 * 1. 阶段 0（不压缩）：上下文 ≤ 预算 × triggerRatio，什么都不做。
 * 2. 阶段 1（工具结果摘要）：从最早的 tool_result 开始，逐个摘要替换。
 * 3. 阶段 2（整轮摘要）：把较早的整个对话轮次摘要为一段话。
 * 4. 阶段 3（省略降级）：摘要后仍超预算，降级到省略式截断。
 *
 * 保留区策略：最近 keepRecent 条 + 最后一条 user 消息永不压缩。
 */
import type { ChatMessage } from '../types/llm.js';
import { estimateTokens } from '../utils/tokens.js';
import type { Summarizer } from './summarizer.js';

export interface CompressorConfig {
  /** 触发压缩的阈值比例（默认 0.7） */
  triggerRatio: number;
  /** 单条摘要的 token 上限（默认 200） */
  maxTokensPerSummary: number;
  /** 保留区消息数量（默认 4） */
  keepRecent: number;
}

export const DEFAULT_COMPRESSOR_CONFIG: CompressorConfig = {
  triggerRatio: 0.7,
  maxTokensPerSummary: 200,
  keepRecent: 4,
};

export interface CompressionResult {
  /** 压缩后的消息序列 */
  messages: ChatMessage[];
  /** 压缩前估算 token */
  beforeTokens: number;
  /** 压缩后估算 token */
  afterTokens: number;
  /** 被压缩的消息数量 */
  compressedCount: number;
}

export class Compressor {
  private readonly config: CompressorConfig;
  /** 缓存：messageIndex → compressedText，避免重复调 LLM */
  private readonly cache = new Map<number, string>();

  constructor(
    private readonly summarizer: Summarizer,
    config: Partial<CompressorConfig> = {},
  ) {
    this.config = { ...DEFAULT_COMPRESSOR_CONFIG, ...config };
  }

  /** 清除缓存（push 新事件时调用） */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 分级压缩：如果超预算，逐步压缩直到达标或降级到省略。
   * @param messages 原始消息序列
   * @param bodyBudgetTokens 正文预算 token
   * @param callIdToToolName callId → 工具名映射，用于工具结果摘要
   * @returns 压缩结果
   */
  async compress(
    messages: ChatMessage[],
    bodyBudgetTokens: number,
    callIdToToolName?: Map<string, string>,
  ): Promise<CompressionResult> {
    const beforeTokens = messages.reduce((sum, m) => sum + estimateTokens(m.text), 0);

    // 阶段 0：未达阈值，不压缩
    if (beforeTokens <= bodyBudgetTokens * this.config.triggerRatio) {
      return { messages, beforeTokens, afterTokens: beforeTokens, compressedCount: 0 };
    }

    // 阶段 1：工具结果摘要
    let result = await this.compressToolResults(messages, bodyBudgetTokens, callIdToToolName);
    if (result.afterTokens <= bodyBudgetTokens) {
      return { ...result, beforeTokens };
    }

    // 阶段 2：整轮摘要
    result = await this.compressTurns(result.messages, bodyBudgetTokens);
    if (result.afterTokens <= bodyBudgetTokens) {
      return { ...result, beforeTokens };
    }

    // 阶段 3：省略降级（由 ContextManager 处理，这里返回当前状态）
    return { ...result, beforeTokens };
  }

  /** 阶段 1：压缩工具结果 */
  private async compressToolResults(
    messages: ChatMessage[],
    bodyBudgetTokens: number,
    callIdToToolName?: Map<string, string>,
  ): Promise<CompressionResult> {
    const protectedIndices = this.getProtectedIndices(messages);
    const compressed = [...messages];
    let compressedCount = 0;

    // 从最早的工具结果开始压缩
    for (let i = 0; i < compressed.length; i++) {
      if (protectedIndices.has(i)) continue;
      const msg = compressed[i];
      if (msg === undefined) continue;

      // 只压缩 tool 角色的消息
      if (msg.role !== 'tool') continue;

      // 检查缓存
      const cached = this.cache.get(i);
      if (cached !== undefined) {
        compressed[i] = { ...msg, text: cached };
        compressedCount++;
        continue;
      }

      // 通过 callId 映射获取工具名，无法识别则跳过
      const toolName = callIdToToolName?.get(msg.callId) ?? 'unknown';

      const summary = await this.summarizer.summarizeToolResult({
        toolName,
        args: {},
        result: msg.text,
        maxTokens: this.config.maxTokensPerSummary,
      });

      const summaryText = `[summary] ${summary}`;
      this.cache.set(i, summaryText);
      compressed[i] = { ...msg, text: summaryText };
      compressedCount++;

      // 检查是否已经达标
      const currentTokens = compressed.reduce((sum, m) => sum + estimateTokens(m.text), 0);
      if (currentTokens <= bodyBudgetTokens) break;
    }

    const afterTokens = compressed.reduce((sum, m) => sum + estimateTokens(m.text), 0);
    return { messages: compressed, beforeTokens: 0, afterTokens, compressedCount };
  }

  /** 阶段 2：压缩整轮对话 */
  private async compressTurns(
    messages: ChatMessage[],
    bodyBudgetTokens: number,
  ): Promise<CompressionResult> {
    const protectedIndices = this.getProtectedIndices(messages);
    const compressed = [...messages];
    let compressedCount = 0;

    // 找连续的 user→assistant→tool 轮次，从最早的开始压缩
    let i = 0;
    while (i < compressed.length) {
      if (protectedIndices.has(i)) {
        i++;
        continue;
      }

      const msg = compressed[i];
      if (msg?.role !== 'user') {
        i++;
        continue;
      }

      // 找这一轮的所有消息（user + assistant + tools）
      const turnEnd = this.findTurnEnd(compressed, i, protectedIndices);
      if (turnEnd <= i) {
        i++;
        continue;
      }

      // 提取轮次内容
      const turnMessages = compressed.slice(i, turnEnd + 1);
      const userMsg = turnMessages.find((m) => m.role === 'user');
      const assistantMsg = turnMessages.find((m) => m.role === 'assistant');
      const toolMsgs = turnMessages.filter((m) => m.role === 'tool');

      if (userMsg === undefined) {
        i++;
        continue;
      }

      // 摘要整轮
      const summary = await this.summarizer.summarizeTurn({
        userText: userMsg.text,
        assistantText: assistantMsg?.text ?? '',
        toolSummaries: toolMsgs.map((m) => m.text),
        maxTokens: this.config.maxTokensPerSummary * 2,
      });

      // 用一条 user 消息替换整轮
      const summaryMsg: ChatMessage = {
        role: 'user',
        text: `[compressed turn] ${summary}`,
      };
      compressed.splice(i, turnEnd - i + 1, summaryMsg);
      compressedCount += turnEnd - i + 1;

      // 检查是否已经达标
      const currentTokens = compressed.reduce((sum, m) => sum + estimateTokens(m.text), 0);
      if (currentTokens <= bodyBudgetTokens) break;

      // 继续下一轮（索引不变，因为后面的消息前移了）
    }

    const afterTokens = compressed.reduce((sum, m) => sum + estimateTokens(m.text), 0);
    return { messages: compressed, beforeTokens: 0, afterTokens, compressedCount };
  }

  /** 获取受保护的索引（保留区） */
  private getProtectedIndices(messages: ChatMessage[]): Set<number> {
    const protectedSet = new Set<number>();
    const len = messages.length;

    // 保留最近 keepRecent 条
    for (let i = Math.max(0, len - this.config.keepRecent); i < len; i++) {
      protectedSet.add(i);
    }

    // 保留最后一条 user 消息
    for (let i = len - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        protectedSet.add(i);
        break;
      }
    }

    return protectedSet;
  }

  /** 找一轮对话的结束索引 */
  private findTurnEnd(
    messages: ChatMessage[],
    start: number,
    protectedIndices: Set<number>,
  ): number {
    let end = start;
    for (let i = start + 1; i < messages.length; i++) {
      if (protectedIndices.has(i)) break;
      const msg = messages[i];
      if (msg === undefined) break;
      // 遇到下一个 user 消息，说明新一轮开始
      if (msg.role === 'user') break;
      end = i;
    }
    return end;
  }
}
