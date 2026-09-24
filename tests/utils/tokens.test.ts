import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/types/common.js';
import type { Usage } from '../../src/types/events.js';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  logTokenCalibration,
} from '../../src/utils/tokens.js';

const usage = (inputTokens: number, outputTokens: number): Usage => ({
  inputTokens,
  outputTokens,
});

describe('estimateTokens', () => {
  it('ASCII 按 4 字符 ≈ 1 token 向上取整', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abc')).toBe(1); // ceil(3/4)
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('CJK / 全角按 1 字符 ≈ 1 token', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('。')).toBe(1); // CJK 标点
    expect(estimateTokens('ａ')).toBe(1); // 全角字母
    expect(estimateTokens('한국어')).toBe(3); // 谚文
  });

  it('混合文本分开计数', () => {
    expect(estimateTokens('你好abcd')).toBe(2 + 1); // 2 宽 + ceil(4/4)
    expect(estimateTokens('你好abc')).toBe(2 + 1); // 2 宽 + ceil(3/4)
    expect(estimateTokens('你好abcdef')).toBe(2 + 2); // 2 宽 + ceil(6/4)
  });
});

describe('estimateMessageTokens', () => {
  it('user / tool 消息按文本估算', () => {
    expect(estimateMessageTokens({ role: 'user', text: 'abcd' })).toBe(1);
    expect(estimateMessageTokens({ role: 'tool', callId: 'c1', text: '你好' })).toBe(2);
  });

  it('无 toolCalls 的 assistant 只算文本', () => {
    expect(estimateMessageTokens({ role: 'assistant', text: 'abcd' })).toBe(1);
  });

  it('assistant 消息叠加 toolCalls 的 JSON 估算', () => {
    const toolCalls = [{ callId: 'c1', toolName: 'read_file', args: { path: 'x.txt' } }];
    const est = estimateMessageTokens({ role: 'assistant', text: 'abcd', toolCalls });
    expect(est).toBe(estimateTokens('abcd') + estimateTokens(JSON.stringify(toolCalls)));
  });
});

describe('estimateMessagesTokens', () => {
  it('对消息列表求和', () => {
    const messages = [
      { role: 'user' as const, text: 'abcd' },
      { role: 'assistant' as const, text: '你好' },
    ];
    expect(estimateMessagesTokens(messages)).toBe(1 + 2);
  });
});

describe('logTokenCalibration', () => {
  const makeLogger = (): { logger: Logger; debug: ReturnType<typeof vi.fn> } => {
    const debug = vi.fn();
    const logger: Logger = { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { logger, debug };
  };

  it('输出估算/实际比值（debug 级）', () => {
    const { logger, debug } = makeLogger();
    logTokenCalibration(logger, 100, usage(300, 50));
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith('token calibration', {
      estimated: 100,
      actual: 300,
      ratio: 3,
    });
  });

  it('比值为小数时保留两位', () => {
    const { logger, debug } = makeLogger();
    logTokenCalibration(logger, 300, usage(100, 0));
    expect(debug).toHaveBeenCalledWith('token calibration', {
      estimated: 300,
      actual: 100,
      ratio: 0.33,
    });
  });

  it('估算或实际为 0 时不输出（避免除零与噪音）', () => {
    const { logger, debug } = makeLogger();
    logTokenCalibration(logger, 0, usage(300, 0));
    logTokenCalibration(logger, 100, usage(0, 0));
    expect(debug).not.toHaveBeenCalled();
  });
});
