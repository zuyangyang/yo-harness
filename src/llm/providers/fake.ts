/**
 * 脚本化 Fake Provider。
 *
 * 三个用途：
 * 1. agent-loop / gateway 单测（无网络、确定性强、可断言请求序列）；
 * 2. 本地无密钥冒烟（--fake，见 CLI 装配）；
 * 3. e2e：YO_FAKE_SCRIPT 环境变量注入 NDJSON 响应脚本，驱动子进程行为。
 */
import { z } from 'zod';

import type { ChatOptions, ChatRequest, ChatResponse, LLMClient } from '../../types/llm.js';
import { ToolCallSchema, UsageSchema } from '../../types/events.js';
import { FatalError, ValidationError } from '../../types/errors.js';

/** NDJSON 单行：全字段可选，stopReason/usage 有确定性默认值 */
const ScriptLineSchema = z.object({
  text: z.string().default(''),
  toolCalls: z.array(ToolCallSchema).default([]),
  stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens']).optional(),
  usage: UsageSchema.optional(),
});

const DEFAULT_USAGE = { inputTokens: 10, outputTokens: 10 } as const;

/** 流式增量按 16 字符切块，保证 onTextDelta 有足够粒度可断言 */
const DELTA_CHUNK = 16;

export class FakeLLMClient implements LLMClient {
  readonly name = 'fake';
  /** 收到的每个请求（供测试断言转换正确性） */
  readonly requests: ChatRequest[] = [];

  private cursor = 0;

  constructor(private readonly script: readonly ChatResponse[]) {}

  /** 解析 NDJSON 脚本；坏行报 ValidationError 并带行号 */
  static fromScriptLines(raw: string): FakeLLMClient {
    const lines = raw
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      .filter(({ line }) => line.length > 0);
    const script = lines.map(({ line, no }) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch (err) {
        throw new ValidationError(`YO_FAKE_SCRIPT line ${no}: invalid JSON (${String(err)})`);
      }
      const parsed = ScriptLineSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new ValidationError(`YO_FAKE_SCRIPT line ${no}: ${parsed.error.message}`);
      }
      return toResponse(parsed.data);
    });
    return new FakeLLMClient(script);
  }

  /** 从环境变量构造；未设置时返回 undefined（由装配层决定是否回退） */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): FakeLLMClient | undefined {
    const raw = env.YO_FAKE_SCRIPT;
    return raw === undefined || raw.trim() === '' ? undefined : FakeLLMClient.fromScriptLines(raw);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- 端口是 async，fake 内部同步
  async chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse> {
    this.requests.push(req);
    const next = this.script[this.cursor];
    if (next === undefined) {
      throw new FatalError(
        `fake provider script exhausted after ${this.cursor} response(s); add more script lines`,
      );
    }
    this.cursor += 1;
    if (opts?.onTextDelta !== undefined && next.text.length > 0) {
      for (const chunk of chunkText(next.text)) {
        opts.onTextDelta(chunk);
      }
    }
    return next;
  }

  /** 已消费的脚本行数 */
  get consumed(): number {
    return this.cursor;
  }
}

function toResponse(line: z.infer<typeof ScriptLineSchema>): ChatResponse {
  return {
    text: line.text,
    toolCalls: line.toolCalls,
    stopReason: line.stopReason ?? (line.toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
    usage: line.usage ?? DEFAULT_USAGE,
  };
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += DELTA_CHUNK) {
    chunks.push(text.slice(i, i + DELTA_CHUNK));
  }
  return chunks;
}
