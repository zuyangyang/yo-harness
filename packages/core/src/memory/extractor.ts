/**
 * 记忆提取器：从对话事件中提取语义记忆。
 *
 * 在会话进行中（turn 结束）或结束时调用：把对话文本化 → 发给 LLM →
 * 解析结构化输出 → 价值闸门 → 稳定槽位 upsert / 标题去重 → 存入 MemoryStore。
 *
 * 两道价值闸门：
 * 1. 对话太短（默认 < 100 字符）直接跳过，不调 LLM；
 * 2. LLM 给出的 importance 低于阈值（默认 4）直接丢弃，不落库。
 *
 * 两条写入路径：
 * - 带 key 的候选走 upsertByKey：唯一槽位只保留最新值（确定性更新）；
 * - 不带 key 的候选按归一化标题精确去重后 create。
 */
import type { Logger } from '../types/common.js';
import type { EventEnvelope } from '../types/events.js';
import { MemoryExtractionSchema } from '../types/memory.js';
import type { MemoryCategory, MemoryDurability } from '../types/memory.js';
import type { LLMClient } from '../types/llm.js';
import type { MemoryStore } from '../core/ports.js';
import type { z } from 'zod';

/** 低于该重要度的候选直接丢弃（Generative Agents 式 1-10 打分） */
export const DEFAULT_MIN_IMPORTANCE = 4;
/** 这些类别被视为长期身份事实：强制 durable + pinned，免疫过期 */
export const DEFAULT_DURABLE_CATEGORIES: MemoryCategory[] = ['preference'];
/** ephemeral 候选未给出 TTL 时的默认过期天数 */
export const DEFAULT_EPHEMERAL_TTL_DAYS = 14;

export interface MemoryExtractOptions {
  /** 对话文本不足该字符数则跳过（默认 100） */
  minChars?: number;
  /** 进 prompt 的已有标题上限（默认 200） */
  maxExistingTitles?: number;
  /** 重要度下限，低于此值不落库（默认 4） */
  minImportance?: number;
  /** 强制 durable + pinned 的类别（默认 ['preference']） */
  durableCategories?: MemoryCategory[];
  /** ephemeral 未给 TTL 时的默认天数（默认 14；<= 0 表示不过期） */
  defaultEphemeralTtlDays?: number;
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
   * @returns 实际写入（新建或更新）的记忆数量
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

    const minImportance = options.minImportance ?? DEFAULT_MIN_IMPORTANCE;
    const durableCategories = new Set<MemoryCategory>(
      options.durableCategories ?? DEFAULT_DURABLE_CATEGORIES,
    );
    const defaultTtlDays = options.defaultEphemeralTtlDays ?? DEFAULT_EPHEMERAL_TTL_DAYS;

    // 程序化去重：标题归一化后精确匹配，避免 LLM 重复产出
    const seen = new Set(existing.map(normalizeTitle));
    const sessionId = this.getSessionId(events);
    let skippedLowValue = 0;
    let upserted = 0;
    let created = 0;

    for (const m of parsed.memories) {
      // 闸门二：低重要度直接忽略
      const importance = clampImportance(m.importance);
      if (importance < minImportance) {
        skippedLowValue += 1;
        continue;
      }

      const isDurableCategory = durableCategories.has(m.category);
      const durability: MemoryDurability = isDurableCategory
        ? 'durable'
        : (m.durability ?? 'durable');
      const expiresAt = resolveExpiresAt(durability, m.expiresInDays, defaultTtlDays);

      const fields = {
        title: m.title,
        content: m.content,
        category: m.category,
        description: m.description,
        keywords: m.keywords,
        status: 'active' as const,
        sourceSessionId: sessionId,
        importance,
        durability,
        ...(m.confidence !== undefined ? { confidence: m.confidence } : {}),
        ...(isDurableCategory ? { pinned: true } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };

      // 路径一：稳定槽位 → 确定性 upsert（覆盖旧值，不产生重复）
      if (m.key !== undefined) {
        await this.store.upsertByKey({ ...fields, key: m.key });
        upserted += 1;
        continue;
      }

      // 路径二：无槽位 → 归一化标题去重后创建
      const titleKey = normalizeTitle(m.title);
      if (seen.has(titleKey)) continue;
      seen.add(titleKey);
      await this.store.create(fields);
      created += 1;
    }

    const written = created + upserted;
    if (written > 0) {
      this.logger.info(
        'extracted ' + written + ' memories from session ' + sessionId +
          ' (created=' + created + ', upserted=' + upserted + ')',
      );
    }
    if (skippedLowValue > 0) {
      this.logger.debug('skipped ' + skippedLowValue + ' low-value memories');
    }
    return written;
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
      '- Small talk, acknowledgements, or passing remarks the assistant made about itself',
      '',
      'If nothing durable is worth remembering, return {"memories": []}. Never invent memories to fill the array.',
      '',
      'For every memory you must judge how valuable and how durable it is:',
      '- importance: integer 1-10. 1-2 = trivial or transient, 5 = normal project fact, 8-10 = identity or long-lived commitments (name, language preference, core architecture).',
      '- durability: "durable" for facts that stay true across sessions; "ephemeral" for things true only for a while (current sprint goal, temporary workaround, today\'s scratch file).',
      '- expiresInDays: only for "ephemeral" memories - how many days until it should be forgotten. Omit it for durable memories.',
      '',
      'Use "key" ONLY for a unique identity slot where at most one value can be true, so a newer value must replace the older one:',
      '- profile.name, preference.language, preference.editor, env.repo_root, env.db_path',
      'Do NOT invent keys for ordinary knowledge, and never use two different keys for the same concept.',
      'A key must match ^[a-z0-9_.]+$ and be at most 64 characters.',
      '',
      'Output a JSON object with a "memories" array. Each memory has:',
      '- title: short label (max 100 chars)',
      '- content: detailed description (max 1000 chars)',
      '- category: one of "preference" | "environment" | "project_knowledge" | "general"',
      '- description: one-line summary for retrieval (max 200 chars)',
      '- keywords: 1-10 keywords for search',
      '- importance: integer 1-10',
      '- durability: "durable" | "ephemeral"',
      '- expiresInDays: integer (only when durability is "ephemeral")',
      '- key: optional stable slot (only for unique identity facts)',
      '- confidence: optional number between 0 and 1',
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

/** 重要度越界时归一到 1-10；缺失时给中性 5 分 */
function clampImportance(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 5;
  return Math.min(10, Math.max(1, Math.round(value)));
}

/** 计算过期时间：durable 永不过期；ephemeral 按 TTL（天） */
function resolveExpiresAt(
  durability: MemoryDurability,
  expiresInDays: number | undefined,
  defaultTtlDays: number,
): string | undefined {
  if (durability === 'durable') return undefined;
  const days = expiresInDays ?? defaultTtlDays;
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
