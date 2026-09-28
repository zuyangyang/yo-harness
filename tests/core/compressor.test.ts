import { describe, expect, it } from 'vitest';

import { Compressor, DEFAULT_COMPRESSOR_CONFIG } from '../../src/core/compressor.js';
import type { Summarizer } from '../../src/core/summarizer.js';
import type { ChatMessage } from '../../src/types/llm.js';

/** 假摘要器：返回固定摘要，不调 LLM */
class FakeSummarizer implements Summarizer {
  summarizeToolResult(input: { toolName: string; result: string }): Promise<string> {
    return Promise.resolve(`[${input.toolName}] summarized`);
  }

  summarizeTurn(input: { userText: string; assistantText: string }): Promise<string> {
    return Promise.resolve(`turn: ${input.userText} → ${input.assistantText}`);
  }
}

function msg(role: 'user' | 'assistant' | 'tool', text: string, callId?: string): ChatMessage {
  return callId !== undefined ? { role, callId, text } : { role, text };
}

describe('Compressor', () => {
  it('阶段 0：未达阈值不压缩', async () => {
    const compressor = new Compressor(new FakeSummarizer(), { triggerRatio: 0.7, keepRecent: 2 });
    const messages = [msg('user', 'short'), msg('assistant', 'ok')];

    const result = await compressor.compress(messages, 1000);

    expect(result.compressedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('阶段 1：压缩工具结果，保留区保护', async () => {
    const compressor = new Compressor(new FakeSummarizer(), {
      triggerRatio: 0.7,
      keepRecent: 2,
      maxTokensPerSummary: 50,
    });

    // 8 条消息：2 组对话，每组 user + assistant + tool + assistant
    // 保留区 = 最后 2 条 + 最后一条 user
    const messages = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('tool', 'long result 1 '.repeat(200), 'c1'), // idx 2, 可压缩
      msg('assistant', 'a1b'),
      msg('user', 'q2'), // idx 4, 保留（最后一条 user）
      msg('assistant', 'a2'),
      msg('tool', 'long result 2 '.repeat(200), 'c2'), // idx 6, 保留（keepRecent）
      msg('assistant', 'a2b'), // idx 7, 保留（keepRecent）
    ];

    // 预算 1200：阶段 1 压缩一个工具结果（约 500 tokens）后就达标（1406 - 500 = 906 < 1200）
    const result = await compressor.compress(messages, 1200, new Map([['c1', 'read_file'], ['c2', 'read_file']]));

    expect(result.compressedCount).toBeGreaterThanOrEqual(1);
    // 找到被压缩的工具消息
    const compressedTool = result.messages.find((m) => m.role === 'tool' && m.text.includes('[summary]'));
    expect(compressedTool).toBeDefined();
    expect(compressedTool?.text).toContain('[read_file] summarized');
    // idx 6 的工具消息被保护（keepRecent）
    expect(result.messages[6]?.text).not.toContain('[summary]');
    // 消息总数不变（阶段 1 只替换文本，不合并消息）
    expect(result.messages.length).toBe(messages.length);
  });

  it('缓存：同一索引重复压缩只调一次 summarizer', async () => {
    let callCount = 0;
    const countingSummarizer: Summarizer = {
      summarizeToolResult() {
        callCount++;
        return Promise.resolve('cached summary');
      },
      summarizeTurn() {
        return Promise.resolve('turn summary');
      },
    };

    const compressor = new Compressor(countingSummarizer, { triggerRatio: 0.7, keepRecent: 0 });
    const messages = [
      msg('user', 'q'),
      msg('tool', 'long'.repeat(100), 'c1'),
    ];

    // 第一次压缩
    await compressor.compress(messages, 10, new Map([['c1', 'read_file']]));
    const firstCount = callCount;

    // 第二次压缩（缓存命中）
    await compressor.compress(messages, 10, new Map([['c1', 'read_file']]));
    expect(callCount).toBe(firstCount); // 没有新增调用
  });

  it('clearCache：清除后重新调 summarizer', async () => {
    let callCount = 0;
    const countingSummarizer: Summarizer = {
      summarizeToolResult() {
        callCount++;
        return Promise.resolve('summary');
      },
      summarizeTurn() {
        return Promise.resolve('turn');
      },
    };

    const compressor = new Compressor(countingSummarizer, { triggerRatio: 0.7, keepRecent: 0 });
    const messages = [msg('user', 'q'), msg('tool', 'long'.repeat(100), 'c1')];

    await compressor.compress(messages, 10, new Map([['c1', 'read_file']]));
    const firstCount = callCount;

    compressor.clearCache();
    await compressor.compress(messages, 10, new Map([['c1', 'read_file']]));
    expect(callCount).toBeGreaterThan(firstCount);
  });

  it('阶段 2：整轮摘要', async () => {
    const compressor = new Compressor(new FakeSummarizer(), {
      triggerRatio: 0.7,
      keepRecent: 0,
      maxTokensPerSummary: 50,
    });

    // 两轮对话，每轮 user + assistant + tool
    const messages = [
      msg('user', 'q1'),
      msg('assistant', 'a1'),
      msg('tool', 'r1 '.repeat(200), 'c1'),
      msg('user', 'q2'),
      msg('assistant', 'a2'),
      msg('tool', 'r2 '.repeat(200), 'c2'),
    ];

    const result = await compressor.compress(messages, 50, new Map([['c1', 't1'], ['c2', 't2']]));

    // 至少有一轮被压缩
    expect(result.compressedCount).toBeGreaterThanOrEqual(1);
    // 压缩后的消息数减少（整轮摘要会把多条消息合并为一条）
    expect(result.messages.length).toBeLessThanOrEqual(messages.length);
  });

  it('默认配置值', () => {
    expect(DEFAULT_COMPRESSOR_CONFIG.triggerRatio).toBe(0.7);
    expect(DEFAULT_COMPRESSOR_CONFIG.maxTokensPerSummary).toBe(200);
    expect(DEFAULT_COMPRESSOR_CONFIG.keepRecent).toBe(4);
  });
});
