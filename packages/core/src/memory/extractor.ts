/**
 * 记忆提取器：从对话事件中提取语义记忆。
 *
 * 在会话进行中（turn 结束）或结束时调用：把对话文本化 → 发给 LLM →
 * 解析结构化输出 → 去重 → 存入 MemoryStore。对话太短（默认 < 100 字符）时跳过。
 */
import type { Logger } from '../types/common.js';
import type { EventEnvelope } from '../types/events.js';
import { MemoryExtractionSchema } from '../types/memory.js';
import type { LLMClient } from '../types/llm.js';
import type { MemoryStore } from '../core/ports.js';
import type { z } from 'zod';

export interface MemoryExtractOptions {
  /** 对话文本不足该字符数则跳过（默认 100） */
  minChars?: number;
  /** 进 prompt 的已有标题上限（默认 200） */
  maxExistingTitles?: number;
}

export interface MemoryUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class MemoryExtractor {
  constructor(
    private readonly llm: LLMClient,
    private readonly store: MemoryStore,
    private readonly logger: Logger,
    private readonly temperature = 0,
    /** 可选：真实用量回调，供装配层记入 CostTracker（role = extractor） */
    private readonly onUsage?: (usage: MemoryUsage) => void,
  ) {}

  /**
   * 从会话事件中提取记忆。
   *
   * @param events 待提取的事件切片（增量时只传游标之后的部分）
   * @param existingTitles 已有记忆标题（去重参考）
   * @param options 阈值与上限
   * @returns 新写入的记忆数量
   */
  async extract(
    events: EventEnvelope[],
    existingTitles: string[],
    options: MemoryExtractOptions = {},
  ): Promise<number> {
    const minChars = options.minChars ?? 100;
    const conversationText = this.extractConversationText(events);
    if (conversationText.length < minChars) {
      this.logger.debug('memory extraction skipped: conversation too short');
      return 0;
    }

    const existing = existingTitles.slice(0, options.maxExistingTitles ?? 200);
    const prompt = this.buildExtractionPrompt(conversationText, existing);

    let response;
    try {
      response = await this.llm.chat({
        system: prompt.system,
        messages: [{ role: 'user', text: prompt.user }],
        tools: [],
        maxTokens: 2000,
        temperature: this.temperature,
      });
    } catch (err) {
      this.logger.warn('memory extraction LLM call failed: ' + String(err));
      return 0;
    }

    this.onUsage?.({
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      model: this.llm.model,
    });

    const parsed = this.parseExtractionResponse(response.text);

    // 程序化去重：标题归一化后精确匹配，避免 LLM 重复产出
    const seen = new Set(existing.map(normalizeTitle));
    const sessionId = this.getSessionId(events);
    let created = 0;
    for (const m of parsed.memories) {
      const key = normalizeTitle(m.title);
      if (seen.has(key)) continue;
      seen.add(key);
      await this.store.create({
        title: m.title,
        content: m.content,
        category: m.category,
        description: m.description,
        keywords: m.keywords,
        status: 'active',
        sourceSessionId: sessionId,
      });
      created += 1;
    }

    if (created > 0) {
      this.logger.info('extracted ' + created + ' memories from session ' + sessionId);
    }
    return created;
  }

  private buildExtractionPrompt(
    conversation: string,
    existingTitles: string[],
  ): { system: string; user: string } {
    const known = existingTitles.map((t) => '- ' + t).join('\n') || '(none)';
    const system = [
      'You are a memory extraction system. Analyze the conversation and extract reusable knowledge that should be remembered across sessions.',
      '',
      'Focus on:',
      '- User preferences (coding style, tool choices, workflow habits)',
      '- Environment facts (project structure, tech stack, deployment setup)',
      '- Project knowledge (architecture decisions, naming conventions, constraints)',
      '',
      'Do NOT extract:',
      '- Specific code changes or bug fixes (those are in git history)',
      '- Temporary debugging steps',
      '- Information already captured (see existing memories below)',
      '- Imperative instructions or requests (only durable facts)',
      '',
      'Output a JSON object with a "memories" array. Each memory has:',
      '- title: short label (max 100 chars)',
      '- content: detailed description (max 1000 chars)',
      '- category: one of "preference" | "environment" | "project_knowledge" | "general"',
      '- description: one-line summary for retrieval (max 200 chars)',
      '- keywords: 1-10 keywords for search',
      '',
      'Existing memories (do not duplicate):',
      known,
    ].join('\n');
    return { system, user: 'Extract memories from this conversation:\n\n' + conversation };
  }

  private extractConversationText(events: EventEnvelope[]): string {
    return events
      .filter((e) => e.payload.type === 'user_input' || e.payload.type === 'assistant_text')
      .map((e) => {
        const p = e.payload;
        if (p.type === 'user_input') return 'User: ' + p.content;
        if (p.type === 'assistant_text') return 'Assistant: ' + p.text;
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n\n');
  }

  private parseExtractionResponse(text: string): z.infer<typeof MemoryExtractionSchema> {
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (jsonMatch === null) return { memories: [] };
    try {
      return MemoryExtractionSchema.parse(JSON.parse(jsonMatch[0]));
    } catch (err) {
      this.logger.warn('memory extraction parse failed: ' + String(err));
      return { memories: [] };
    }
  }

  private getSessionId(events: EventEnvelope[]): string {
    return events[0]?.sessionId ?? 'unknown';
  }
}

/** 标题归一化：小写 + 空白折叠，用于去重 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}
