/**
 * 记忆提取器：从对话事件中提取语义记忆。
 *
 * 在会话结束时调用：把对话文本化 → 发给 LLM → 解析结构化输出 →
 * 去重 → 存入 MemoryStore。对话太短（< 100 字符）时跳过提取。
 */
import type { Logger } from '../types/common.js';
import type { EventEnvelope } from '../types/events.js';
import { MemoryExtractionSchema } from '../types/memory.js';
import type { LLMClient } from '../types/llm.js';
import type { MemoryStore } from '../core/ports.js';
import type { z } from 'zod';

export class MemoryExtractor {
  constructor(
    private readonly llm: LLMClient,
    private readonly store: MemoryStore,
    private readonly logger: Logger,
  ) {}

  /**
   * 从会话事件中提取记忆。
   *
   * @param events 会话的完整事件流
   * @param existingTitles 已有记忆标题（用于去重）
   * @returns 新提取的记忆数量
   */
  async extract(events: EventEnvelope[], existingTitles: string[]): Promise<number> {
    const conversationText = this.extractConversationText(events);
    if (conversationText.length < 100) {
      this.logger.debug('memory extraction skipped: conversation too short');
      return 0;
    }

    const prompt = this.buildExtractionPrompt(conversationText, existingTitles);

    let response;
    try {
      response = await this.llm.chat(
        {
          system: prompt.system,
          messages: [{ role: 'user', text: prompt.user }],
          tools: [],
          maxTokens: 2000,
        },
        { onTextDelta: () => {} },
      );
    } catch (err) {
      this.logger.warn(`memory extraction LLM call failed: ${String(err)}`);
      return 0;
    }

    const parsed = this.parseExtractionResponse(response.text);
    if (parsed.memories.length === 0) return 0;

    const sessionId = this.getSessionId(events);
    for (const m of parsed.memories) {
      await this.store.create({
        title: m.title,
        content: m.content,
        category: m.category,
        description: m.description,
        keywords: m.keywords,
        status: 'active',
        sourceSessionId: sessionId,
      });
    }

    this.logger.info(`extracted ${parsed.memories.length} memories from session ${sessionId}`);
    return parsed.memories.length;
  }

  private buildExtractionPrompt(
    conversation: string,
    existingTitles: string[],
  ): { system: string; user: string } {
    return {
      system: `You are a memory extraction system. Analyze the conversation and extract reusable knowledge that should be remembered across sessions.

Focus on:
- User preferences (coding style, tool choices, workflow habits)
- Environment facts (project structure, tech stack, deployment setup)
- Project knowledge (architecture decisions, naming conventions, constraints)

Do NOT extract:
- Specific code changes or bug fixes (those are in git history)
- Temporary debugging steps
- Information already captured (see existing memories below)

Output a JSON object with a "memories" array. Each memory has:
- title: short label (max 100 chars)
- content: detailed description (max 1000 chars)
- category: one of "preference" | "environment" | "project_knowledge" | "general"
- description: one-line summary for retrieval (max 200 chars)
- keywords: 1-10 keywords for search

Existing memories (do not duplicate):
${existingTitles.map((t) => `- ${t}`).join('\n') || '(none)'}`,
      user: `Extract memories from this conversation:\n\n${conversation}`,
    };
  }

  private extractConversationText(events: EventEnvelope[]): string {
    return events
      .filter((e) => e.payload.type === 'user_input' || e.payload.type === 'assistant_text')
      .map((e) => {
        const p = e.payload;
        if (p.type === 'user_input') return `User: ${p.content}`;
        if (p.type === 'assistant_text') return `Assistant: ${p.text}`;
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n\n');
  }

  private parseExtractionResponse(text: string): z.infer<typeof MemoryExtractionSchema> {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch === null) return { memories: [] };
    try {
      return MemoryExtractionSchema.parse(JSON.parse(jsonMatch[0]));
    } catch (err) {
      this.logger.warn(`memory extraction parse failed: ${String(err)}`);
      return { memories: [] };
    }
  }

  private getSessionId(events: EventEnvelope[]): string {
    return events[0]?.sessionId ?? 'unknown';
  }
}
