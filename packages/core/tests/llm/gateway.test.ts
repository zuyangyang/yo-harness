import { describe, expect, it } from 'vitest';

import type { ChatOptions, ChatRequest, ChatResponse, LLMClient } from '../../src/types/llm.js';
import { LLMGateway } from '../../src/llm/gateway.js';
import { FatalError, TransientError, ValidationError } from '../../src/types/errors.js';

const OK: ChatResponse = {
  text: 'ok',
  toolCalls: [],
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
};

/** 可编程 client：前 failTimes 次抛 err，之后返回 OK */
class FlakyClient implements LLMClient {
  readonly name: string;
  readonly model = 'test-model';
  attempts = 0;
  constructor(
    name: string,
    private readonly failTimes: number,
    private readonly err: Error,
  ) {
    this.name = name;
  }

  async chat(): Promise<ChatResponse> {
    this.attempts += 1;
    if (this.attempts <= this.failTimes) {
      throw this.err;
    }
    return OK;
  }
}

/** 记录请求的普通 client */
class RecordingClient implements LLMClient {
  readonly name: string;
  readonly model = 'test-model';
  readonly requests: ChatRequest[] = [];
  constructor(name: string) {
    this.name = name;
  }

  async chat(req: ChatRequest, _opts?: ChatOptions): Promise<ChatResponse> {
    this.requests.push(req);
    return { ...OK, text: this.name };
  }
}

function fakeSleeper(log: number[]): (ms: number) => Promise<void> {
  return (ms: number) => {
    log.push(ms);
    return Promise.resolve();
  };
}

describe('LLMGateway', () => {
  it('构造时未知 provider 报 FatalError 并列出可用项', () => {
    const clients = new Map<string, LLMClient>([['anthropic', new RecordingClient('anthropic')]]);
    expect(() => new LLMGateway(clients, { defaultProvider: 'nope' })).toThrow(
      /unknown llm provider 'nope'.*anthropic/,
    );
  });

  it('路由到 defaultProvider 指定的 client', async () => {
    const anthropic = new RecordingClient('anthropic');
    const openai = new RecordingClient('openai');
    const gateway = new LLMGateway(
      new Map([
        ['anthropic', anthropic],
        ['openai', openai],
      ]),
      { defaultProvider: 'openai' },
    );

    const req: ChatRequest = {
      system: 's',
      messages: [{ role: 'user', text: 'hi' }],
      tools: [],
      maxTokens: 16,
    };
    const res = await gateway.chat(req);

    expect(res.text).toBe('openai');
    expect(openai.requests).toHaveLength(1);
    expect(anthropic.requests).toHaveLength(0);
    expect(gateway.provider).toBe('openai');
    // 网关自身满足 LLMClient 端口（AgentLoop 可直接依赖）
    expect(gateway.name).toBe('openai');
  });

  it('TransientError 按 1s/2s/4s 退避重试，成功后返回', async () => {
    const delays: number[] = [];
    const client = new FlakyClient('flaky', 2, new TransientError('429'));
    const gateway = new LLMGateway(new Map([['flaky', client]]), {
      defaultProvider: 'flaky',
      sleeper: fakeSleeper(delays),
    });

    const res = await gateway.chat({ system: 's', messages: [], tools: [], maxTokens: 1 });

    expect(res.text).toBe('ok');
    expect(client.attempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it('重试耗尽后上抛最后的 TransientError（共 1+3 次尝试）', async () => {
    const delays: number[] = [];
    const client = new FlakyClient('flaky', 99, new TransientError('503'));
    const gateway = new LLMGateway(new Map([['flaky', client]]), {
      defaultProvider: 'flaky',
      sleeper: fakeSleeper(delays),
    });

    await expect(
      gateway.chat({ system: 's', messages: [], tools: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(client.attempts).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('自定义 maxRetries=1：只退避一次', async () => {
    const delays: number[] = [];
    const client = new FlakyClient('flaky', 99, new TransientError('timeout'));
    const gateway = new LLMGateway(new Map([['flaky', client]]), {
      defaultProvider: 'flaky',
      maxRetries: 1,
      sleeper: fakeSleeper(delays),
    });

    await expect(
      gateway.chat({ system: 's', messages: [], tools: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(client.attempts).toBe(2);
    expect(delays).toEqual([1000]);
  });

  it('ValidationError 不重试，直接上抛', async () => {
    const delays: number[] = [];
    const client = new FlakyClient('flaky', 1, new ValidationError('bad request'));
    const gateway = new LLMGateway(new Map([['flaky', client]]), {
      defaultProvider: 'flaky',
      sleeper: fakeSleeper(delays),
    });

    await expect(
      gateway.chat({ system: 's', messages: [], tools: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(client.attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('FatalError 不重试，直接上抛', async () => {
    const client = new FlakyClient('flaky', 1, new FatalError('401'));
    const gateway = new LLMGateway(new Map([['flaky', client]]), { defaultProvider: 'flaky' });

    await expect(
      gateway.chat({ system: 's', messages: [], tools: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(FatalError);
    expect(client.attempts).toBe(1);
  });

  it('累计 usage 并逐次回调上报', async () => {
    const reported: { usage: { inputTokens: number; outputTokens: number }; provider: string }[] = [];
    const client = new FlakyClient('flaky', 1, new TransientError('502'));
    const gateway = new LLMGateway(new Map([['flaky', client]]), {
      defaultProvider: 'flaky',
      sleeper: fakeSleeper([]),
      onUsage: (usage, provider) => {
        reported.push({ usage, provider });
      },
    });

    await gateway.chat({ system: 's', messages: [], tools: [], maxTokens: 1 });
    await gateway.chat({ system: 's', messages: [], tools: [], maxTokens: 1 });

    expect(reported).toHaveLength(2);
    expect(reported[0]).toEqual({
      usage: { inputTokens: 10, outputTokens: 5 },
      provider: 'flaky',
    });
    expect(gateway.totalUsage()).toEqual({ inputTokens: 20, outputTokens: 10 });
  });

  it('超时中止：requestTimeoutMs 到期后每次尝试独立计时并按 TransientError 重试', async () => {
    let abortCount = 0;
    const slowClient: LLMClient = {
      name: 'slow',
      model: 'test-model',
      async chat(_req, opts) {
        await new Promise<void>((_resolve, reject) => {
          const signal = opts?.signal;
          // provider 层已把 abort 分类为 TransientError（这里直接抛分类后的错误）
          const rejectFn = () => reject(new TransientError('request timed out'));
          if (signal?.aborted) {
            abortCount += 1;
            rejectFn();
            return;
          }
          signal?.addEventListener('abort', () => { abortCount += 1; rejectFn(); }, { once: true });
        });
        return OK;
      },
    };
    const delays: number[] = [];
    const gateway = new LLMGateway(new Map([['slow', slowClient]]), {
      defaultProvider: 'slow',
      requestTimeoutMs: 10,
      sleeper: fakeSleeper(delays),
    });

    await expect(
      gateway.chat({ system: 's', messages: [], tools: [], maxTokens: 1 }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(abortCount).toBe(4); // 初始 1 次 + 3 次重试，每次超时
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('用户中断：外部 signal 已 abort 时不重试直接上抛', async () => {
    const slowClient: LLMClient = {
      name: 'slow',
      model: 'test-model',
      async chat(_req, opts) {
        await new Promise<void>((_resolve, reject) => {
          const signal = opts?.signal;
          if (signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
        return OK;
      },
    };
    const delays: number[] = [];
    const gateway = new LLMGateway(new Map([['slow', slowClient]]), {
      defaultProvider: 'slow',
      sleeper: fakeSleeper(delays),
    });

    const controller = new AbortController();
    const chatPromise = gateway.chat(
      { system: 's', messages: [], tools: [], maxTokens: 1 },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(chatPromise).rejects.toBeInstanceOf(DOMException);
    expect(delays).toEqual([]); // 不重试
  });
});
