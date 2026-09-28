import { describe, expect, it } from 'vitest';

import { FallbackSummarizer, LlmSummarizer } from '../../src/core/summarizer.js';
import { FakeLLMClient } from '../../src/llm/providers/fake.js';
import type { ChatResponse } from '../../src/types/llm.js';

function resp(text: string): ChatResponse {
  return { text, toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } };
}

describe('FallbackSummarizer', () => {
  it('summarizeToolResult：短文本原样返回，长文本截断', async () => {
    const summarizer = new FallbackSummarizer(50);

    const short = await summarizer.summarizeToolResult({
      toolName: 'read_file',
      args: { path: 'x.txt' },
      result: 'short content',
      maxTokens: 100,
    });
    expect(short).toBe('[read_file] short content');

    const long = await summarizer.summarizeToolResult({
      toolName: 'read_file',
      args: { path: 'y.txt' },
      result: 'a'.repeat(100),
      maxTokens: 100,
    });
    expect(long).toContain('[read_file]');
    expect(long).toContain('... [truncated]');
    expect(long.length).toBeLessThan(100 + 20);
  });

  it('summarizeTurn：拼接 user + assistant，超长截断', async () => {
    const summarizer = new FallbackSummarizer(50);

    const summary = await summarizer.summarizeTurn({
      userText: 'what is x?',
      assistantText: 'x is a file',
      toolSummaries: [],
      maxTokens: 100,
    });
    expect(summary).toContain('User: what is x?');
    expect(summary).toContain('Assistant: x is a file');

    const longSummary = await summarizer.summarizeTurn({
      userText: 'u'.repeat(100),
      assistantText: 'a'.repeat(100),
      toolSummaries: [],
      maxTokens: 100,
    });
    expect(longSummary).toContain('... [truncated]');
  });
});

describe('LlmSummarizer', () => {
  it('summarizeToolResult：调 LLM 返回摘要文本', async () => {
    const fake = new FakeLLMClient([resp('summary of tool result')]);
    const summarizer = new LlmSummarizer(fake);

    const summary = await summarizer.summarizeToolResult({
      toolName: 'read_file',
      args: { path: 'x.txt' },
      result: 'long content here',
      maxTokens: 100,
    });

    expect(summary).toBe('summary of tool result');
    expect(fake.consumed).toBe(1);
    expect(fake.requests[0]?.system).toContain('summarization');
    expect(fake.requests[0]?.messages[0]?.text).toContain('read_file');
  });

  it('summarizeTurn：调 LLM 返回整轮摘要', async () => {
    const fake = new FakeLLMClient([resp('summary of turn')]);
    const summarizer = new LlmSummarizer(fake);

    const summary = await summarizer.summarizeTurn({
      userText: 'what is x?',
      assistantText: 'let me check',
      toolSummaries: ['x is a file'],
      maxTokens: 100,
    });

    expect(summary).toBe('summary of turn');
    expect(fake.consumed).toBe(1);
    expect(fake.requests[0]?.messages[0]?.text).toContain('what is x?');
    expect(fake.requests[0]?.messages[0]?.text).toContain('x is a file');
  });
});
