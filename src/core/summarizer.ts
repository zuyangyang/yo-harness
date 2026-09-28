/**
 * 摘要器：把长文本压缩为短摘要。
 *
 * 接口与实现解耦，测试可注入纯函数（FakeSummarizer）。
 * LlmSummarizer 调 LLM 做摘要；FallbackSummarizer 直接截断（不调 LLM）。
 */
import type { LLMClient } from '../types/llm.js';

/** 摘要器接口：把长文本压缩为短摘要 */
export interface Summarizer {
  /** 摘要单条工具结果 */
  summarizeToolResult(input: {
    toolName: string;
    args: Record<string, unknown>;
    result: string;
    maxTokens: number;
  }): Promise<string>;

  /** 摘要一整轮对话（user + assistant reasoning + 多个 tool 结果） */
  summarizeTurn(input: {
    userText: string;
    assistantText: string;
    toolSummaries: string[];
    maxTokens: number;
  }): Promise<string>;
}

/** LLM 摘要器：调便宜模型做摘要 */
export class LlmSummarizer implements Summarizer {
  constructor(private readonly llm: LLMClient) {}

  async summarizeToolResult(input: {
    toolName: string;
    args: Record<string, unknown>;
    result: string;
    maxTokens: number;
  }): Promise<string> {
    const prompt = `Summarize the following tool result in under ${input.maxTokens} tokens. Keep key findings, file paths, and error information. Remove redundancy and verbose details.

Tool: ${input.toolName}
Args: ${JSON.stringify(input.args, null, 2)}
Result:
${input.result}

Provide a concise summary:`;

    const resp = await this.llm.chat({
      system: 'You are a summarization assistant. Be concise and preserve key information.',
      messages: [{ role: 'user', text: prompt }],
      tools: [],
      maxTokens: input.maxTokens,
    });
    return resp.text.trim();
  }

  async summarizeTurn(input: {
    userText: string;
    assistantText: string;
    toolSummaries: string[];
    maxTokens: number;
  }): Promise<string> {
    const toolsText =
      input.toolSummaries.length > 0
        ? `\nTool results:\n${input.toolSummaries.map((s) => `- ${s}`).join('\n')}`
        : '';

    const prompt = `Summarize the following conversation turn in under ${input.maxTokens} tokens. Preserve the user's intent, key decisions, and important findings.

User: ${input.userText}
Assistant: ${input.assistantText}${toolsText}

Provide a concise summary:`;

    const resp = await this.llm.chat({
      system: 'You are a summarization assistant. Be concise and preserve key information.',
      messages: [{ role: 'user', text: prompt }],
      tools: [],
      maxTokens: input.maxTokens,
    });
    return resp.text.trim();
  }
}

/** 降级摘要器：不调 LLM，直接截断 */
export class FallbackSummarizer implements Summarizer {
  constructor(private readonly maxChars = 500) {}

  summarizeToolResult(input: {
    toolName: string;
    args: Record<string, unknown>;
    result: string;
    maxTokens: number;
  }): Promise<string> {
    const truncated =
      input.result.length > this.maxChars
        ? `${input.result.slice(0, this.maxChars)}... [truncated]`
        : input.result;
    return Promise.resolve(`[${input.toolName}] ${truncated}`);
  }

  summarizeTurn(input: {
    userText: string;
    assistantText: string;
    toolSummaries: string[];
    maxTokens: number;
  }): Promise<string> {
    const toolsText =
      input.toolSummaries.length > 0
        ? `\nTool results:\n${input.toolSummaries.map((s) => `- ${s}`).join('\n')}`
        : '';
    const combined = `User: ${input.userText}\nAssistant: ${input.assistantText}${toolsText}`;
    const truncated =
      combined.length > this.maxChars
        ? `${combined.slice(0, this.maxChars)}... [truncated]`
        : combined;
    return Promise.resolve(truncated);
  }
}
