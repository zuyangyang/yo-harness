/**
 * LLM 网关：路由 / 重试 / 用量统计。
 *
 * - 按 defaultProvider 从注册的 Map 中选 LLMClient（依赖倒置，网关不知道
 *   具体实现是 anthropic、openai-compat 还是 fake）；
 * - 仅重试 TransientError（429/5xx/网络抖动），指数退避 1s/2s/4s；
 *   ValidationError / FatalError 立即上抛（重试无意义）；
 * - 累计 usage 并回调上报（CLI 按会话记账用）；
 * - 模型选择在各 Provider 适配器构造时固化（--model 覆写在装配层完成透传）。
 */
import type { ChatOptions, ChatRequest, ChatResponse, LLMClient } from '../types/llm.js';
import type { Usage } from '../types/events.js';
import { FatalError, TransientError } from '../types/errors.js';

export interface LLMGatewayConfig {
  defaultProvider: string;
  /** 初始失败后的最大重试次数（默认 3，配合 1s/2s/4s 退避） */
  maxRetries?: number;
  /** 退避序列（毫秒），默认 [1000, 2000, 4000]；越界取末位 */
  backoffMs?: readonly number[];
  /** 可注入的睡眠函数（测试用假时钟，不真实等待） */
  sleeper?: (ms: number) => Promise<void>;
  /** 每次成功调用的用量上报（会话记账） */
  onUsage?: (usage: Usage, provider: string) => void;
}

const DEFAULT_BACKOFF: readonly number[] = [1000, 2000, 4000];

export class LLMGateway {
  private readonly clients: ReadonlyMap<string, LLMClient>;
  private readonly config: LLMGatewayConfig;
  private readonly total: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(clients: ReadonlyMap<string, LLMClient>, config: LLMGatewayConfig) {
    if (!clients.has(config.defaultProvider)) {
      throw new FatalError(
        `unknown llm provider '${config.defaultProvider}' (available: ${[...clients.keys()].join(', ') || 'none'})`,
      );
    }
    this.clients = clients;
    this.config = config;
  }

  get provider(): string {
    return this.config.defaultProvider;
  }

  /** LLMClient 端口名：内核（AgentLoop 等）直接依赖网关时使用 */
  get name(): string {
    return this.config.defaultProvider;
  }

  /** Phase 2: 按 provider 名获取特定的 LLMClient（压缩等场景用） */
  getClient(providerName: string): LLMClient | undefined {
    return this.clients.get(providerName);
  }

  async chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse> {
    const client = this.clients.get(this.config.defaultProvider);
    // 构造函数已校验，此处仅防御
    if (client === undefined) {
      throw new FatalError(`unknown llm provider '${this.config.defaultProvider}'`);
    }

    const maxRetries = this.config.maxRetries ?? DEFAULT_BACKOFF.length;
    const backoff = this.config.backoffMs ?? DEFAULT_BACKOFF;
    const sleep = this.config.sleeper ?? defaultSleep;

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await client.chat(req, opts);
        this.total.inputTokens += res.usage.inputTokens;
        this.total.outputTokens += res.usage.outputTokens;
        this.config.onUsage?.(res.usage, client.name);
        return res;
      } catch (err) {
        if (!(err instanceof TransientError) || attempt >= maxRetries) {
          throw err;
        }
        await sleep(backoff[Math.min(attempt, backoff.length - 1)] ?? 1000);
      }
    }
  }

  /** 网关生命周期内的累计用量 */
  totalUsage(): Usage {
    return { ...this.total };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
