/**
 * OpenAI 兼容协议适配器（OpenAI 官方 / DeepSeek / vLLM / 各类网关）。
 *
 * 与 anthropic.ts 对称：只做协议转换。差异点：
 * - system 是 messages[0] 的 {role:'system'}；
 * - assistant 空文本 + tool_calls → content 必须为 null（空串会 400）；
 * - tool 结果是独立的 {role:'tool'} 消息（无 is_error 字段，错误即正文）；
 * - arguments 是 JSON 字符串：出站 stringify，入站 parse；
 * - finish_reason：'tool_calls'→tool_use，'length'→max_tokens，其余→end_turn；
 * - 流式需 stream_options.include_usage 才有 usage（最终 usage-only chunk 的
 *   choices 为空数组，须容错跳过）；tool_call 分片按 index 累积。
 */
import OpenAI from 'openai';

import type { ToolCall } from '../../types/events.js';
import type { ChatMessage, ChatOptions, ChatRequest, ChatResponse, LLMClient, StopReason } from '../../types/llm.js';
import { FatalError, ValidationError } from '../../types/errors.js';
import type { ToolSpec } from '../../types/tools.js';
import { classifyProviderError } from '../provider-errors.js';
import { parseToolArgs } from './tool-args.js';

/** 窄传输端口：真 SDK client 结构性满足；测试注入 mock（CI 零网络） */
export interface OpenAICompatTransport {
  create(
    params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<OpenAI.Chat.ChatCompletion>;
  createStream(
    params: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>;
}

/** 生产装配：真 SDK client → 传输端口 */
export function openaiSdkTransport(client: OpenAI): OpenAICompatTransport {
  return {
    create: (params, options) => client.chat.completions.create(params, options),
    createStream: (params, options) => client.chat.completions.create(params, options),
  };
}

export class OpenAICompatLLMClient implements LLMClient {
  readonly name: string;

  constructor(
    private readonly transport: OpenAICompatTransport,
    private readonly model: string,
    name = 'openai',
  ) {
    this.name = name;
  }

  static create(opts: {
    /** provider 名（网关注册键），默认 'openai'；DeepSeek/vLLM 等自定 */
    name?: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    transport?: OpenAICompatTransport;
  }): OpenAICompatLLMClient {
    const transport =
      opts.transport ??
      openaiSdkTransport(
        new OpenAI({
          ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
          ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        }),
      );
    return new OpenAICompatLLMClient(transport, opts.model, opts.name ?? 'openai');
  }

  async chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse> {
    try {
      // 不标注 SDK 的 *ParamsBase（未从 client 命名空间导出）：
      // 推断出的共享字段在 spread + stream 字面量处按目标参数做上下文检查
      const base = {
        model: this.model,
        messages: toOpenAIMessages(req.system, req.messages),
        // 兼容协议事实标准是 max_tokens（max_completion_tokens 官方新参数，
        // 大量兼容端点不识别）；Phase 1 面向兼容端点，统一用 max_tokens
        max_tokens: req.maxTokens,
        ...(req.tools.length > 0 ? { tools: toOpenAITools(req.tools) } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      };
      const signalOpt = opts?.signal !== undefined ? { signal: opts.signal } : undefined;
      if (opts?.onTextDelta) {
        const stream = await this.transport.createStream(
          {
            ...base,
            stream: true,
            stream_options: { include_usage: true },
          },
          signalOpt,
        );
        return await foldStream(stream, opts.onTextDelta);
      }
      const completion = await this.transport.create({ ...base, stream: false }, signalOpt);
      return fromCompletion(completion);
    } catch (err) {
      throw classifyProviderError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// 出站转换：system + ChatMessage[] → ChatCompletionMessageParam[]
// ---------------------------------------------------------------------------

export function toOpenAIMessages(
  system: string,
  messages: readonly ChatMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls;
      out.push({
        role: 'assistant',
        content: calls !== undefined && calls.length > 0 && m.text === '' ? null : m.text,
        ...(calls === undefined
          ? {}
          : {
              tool_calls: calls.map((call) => ({
                id: call.callId,
                type: 'function' as const,
                function: { name: call.toolName, arguments: JSON.stringify(call.args) },
              })),
            }),
      });
    } else {
      // 协议无 is_error：错误说明即 content 正文（错误文本本身足够模型理解）
      out.push({ role: 'tool', tool_call_id: m.callId, content: m.text });
    }
  }
  return out;
}

function toOpenAITools(specs: readonly ToolSpec[]): OpenAI.Chat.ChatCompletionTool[] {
  return specs.map((spec) => ({
    type: 'function' as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    },
  }));
}

// ---------------------------------------------------------------------------
// 入站转换：ChatCompletion → ChatResponse
// ---------------------------------------------------------------------------

function fromCompletion(completion: OpenAI.Chat.ChatCompletion): ChatResponse {
  const choice = completion.choices[0];
  if (choice === undefined) {
    throw new FatalError('openai-compat: completion contains no choices');
  }
  const toolCalls: ToolCall[] = [];
  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.type !== 'function') {
      throw new ValidationError(`openai-compat: unsupported tool_call type "${tc.type}"`);
    }
    toolCalls.push({ callId: tc.id, toolName: tc.function.name, args: parseToolArgs(tc.function.arguments) });
  }
  return {
    text: choice.message.content ?? '',
    toolCalls,
    stopReason: mapFinishReason(choice.finish_reason),
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

function mapFinishReason(reason: OpenAI.Chat.ChatCompletion.Choice['finish_reason']): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

// ---------------------------------------------------------------------------
// 流式折叠：ChatCompletionChunk[] → ChatResponse
// ---------------------------------------------------------------------------

async function foldStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  onTextDelta: (delta: string) => void,
): Promise<ChatResponse> {
  let text = '';
  let stopReason: StopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;
  /** 按 index 暂存组装中的 tool_call 分片 */
  const openTools = new Map<number, { id: string; name: string; json: string }>();

  for await (const chunk of stream) {
    if (chunk.usage != null) {
      inputTokens = chunk.usage.prompt_tokens;
      outputTokens = chunk.usage.completion_tokens;
    }
    const choice = chunk.choices[0];
    if (choice === undefined) continue; // usage-only 最终 chunk
    if (choice.finish_reason !== null) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
    const delta = choice.delta;
    if (delta.content != null) {
      text += delta.content;
      onTextDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const open = openTools.get(tc.index) ?? { id: '', name: '', json: '' };
      if (tc.id != null && tc.id !== '') open.id = tc.id;
      if (tc.function?.name != null && tc.function.name !== '') open.name += tc.function.name;
      if (tc.function?.arguments != null) open.json += tc.function.arguments;
      openTools.set(tc.index, open);
    }
  }

  // 按协议 index 排序，保证多工具调用顺序确定
  const toolCalls: ToolCall[] = [...openTools.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, open]) => ({ callId: open.id, toolName: open.name, args: parseToolArgs(open.json) }));

  return { text, toolCalls, stopReason, usage: { inputTokens, outputTokens } };
}
