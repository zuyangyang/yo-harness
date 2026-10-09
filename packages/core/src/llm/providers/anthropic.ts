/**
 * Anthropic Messages API 适配器。
 *
 * 职责：ChatRequest/ChatResponse ↔ Anthropic 协议双向转换，仅此而已。
 * 重试 / 用量统计在网关；错误分类在 provider-errors。
 *
 * 关键转换规则（契约测试覆盖）：
 * - 连续 tool 消息必须合并进同一条 user 消息的 tool_result blocks（API 硬约束）；
 * - assistant 空文本 + toolCalls → 不产生 text block（空 text block 会 400）；
 * - 流式：text_delta 即时外抛 + 累积；input_json_delta 按 index 累积，
 *   content_block_stop 时解析为 ToolCall；
 * - stop_reason：'end_turn' | 'tool_use' | 'max_tokens' 直通，其余归一为 'end_turn'。
 */
import Anthropic from '@anthropic-ai/sdk';

import type { ToolCall } from '../../types/events.js';
import type { ChatMessage, ChatOptions, ChatRequest, ChatResponse, LLMClient, StopReason } from '../../types/llm.js';
import { ValidationError } from '../../types/errors.js';
import type { ToolSpec } from '../../types/tools.js';
import { classifyProviderError } from '../provider-errors.js';
import { asRecord, parseToolArgs } from './tool-args.js';

/**
 * 窄传输端口：真 SDK client 结构性满足；测试注入 mock（CI 零网络）。
 * 抽象成两方法而非整个 Messages 资源类，是为了 mock 不必构造 APIPromise。
 */
export interface AnthropicTransport {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Message>;
  createStream(
    params: Anthropic.MessageCreateParamsStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>>;
}

/** 生产装配：真 SDK client → 传输端口 */
export function anthropicSdkTransport(client: Anthropic): AnthropicTransport {
  return {
    create: (params, options) => client.messages.create(params, options),
    createStream: (params, options) => client.messages.create(params, options),
  };
}

export class AnthropicLLMClient implements LLMClient {
  readonly name = 'anthropic';

  constructor(
    private readonly transport: AnthropicTransport,
    private readonly model: string,
  ) {}

  static create(opts: {
    model: string;
    apiKey?: string;
    baseURL?: string;
    transport?: AnthropicTransport;
  }): AnthropicLLMClient {
    const transport =
      opts.transport ??
      anthropicSdkTransport(
        new Anthropic({
          ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
          ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        }),
      );
    return new AnthropicLLMClient(transport, opts.model);
  }

  async chat(req: ChatRequest, opts?: ChatOptions): Promise<ChatResponse> {
    try {
      // 不标注 SDK 的 *ParamsBase（未从 client 命名空间导出）：
      // 推断出的共享字段在 spread + stream 字面量处按目标参数做上下文检查
      const base = {
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      };
      const signalOpt = opts?.signal !== undefined ? { signal: opts.signal } : undefined;
      if (opts?.onTextDelta) {
        const stream = await this.transport.createStream({ ...base, stream: true }, signalOpt);
        return await foldStream(stream, opts.onTextDelta);
      }
      const msg = await this.transport.create({ ...base, stream: false }, signalOpt);
      return fromAnthropicMessage(msg);
    } catch (err) {
      throw classifyProviderError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// 出站转换：ChatMessage[] → MessageParam[]
// ---------------------------------------------------------------------------

export function toAnthropicMessages(messages: readonly ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messages) {
    if (m.role === 'user') {
      flushToolResults();
      out.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      flushToolResults();
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text !== '') blocks.push({ type: 'text', text: m.text });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.callId, name: call.toolName, input: call.args });
      }
      out.push({ role: 'assistant', content: blocks });
    } else {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.callId,
        content: m.text,
        ...(m.isError ? { is_error: true } : {}),
      });
    }
  }
  flushToolResults();
  return out;
}

function toAnthropicTools(specs: readonly ToolSpec[]): Anthropic.Tool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: asObjectSchema(spec.name, spec.inputSchema),
  }));
}

/** ToolSpec.inputSchema 是宽 Record；Anthropic 要求 {type:'object'}，这里做运行时校验 */
function asObjectSchema(toolName: string, schema: Record<string, unknown>): Anthropic.Tool.InputSchema {
  if (schema.type !== 'object') {
    throw new ValidationError(
      `tool "${toolName}" inputSchema must have type "object" (got ${JSON.stringify(schema.type)})`,
    );
  }
  const out: Anthropic.Tool.InputSchema = { type: 'object' };
  for (const [key, value] of Object.entries(schema)) {
    if (key !== 'type') out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 入站转换：Message → ChatResponse
// ---------------------------------------------------------------------------

function fromAnthropicMessage(msg: Anthropic.Message): ChatResponse {
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({ callId: block.id, toolName: block.name, args: asRecord(block.input) });
    }
    // thinking / redacted_thinking / server tool blocks：Phase 1 不消费，忽略
  }
  return {
    text,
    toolCalls,
    stopReason: mapStopReason(msg.stop_reason),
    usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
  };
}

function mapStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
      return reason;
    default:
      return 'end_turn';
  }
}

// ---------------------------------------------------------------------------
// 流式折叠：RawMessageStreamEvent[] → ChatResponse（边折叠边外抛 text delta）
// ---------------------------------------------------------------------------

async function foldStream(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  onTextDelta: (delta: string) => void,
): Promise<ChatResponse> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  let stopReason: StopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;
  /** 按 index 暂存组装中的 tool_use（input_json_delta 分片累积） */
  const openTools = new Map<number, { callId: string; toolName: string; json: string }>();

  const closeTool = (open: { callId: string; toolName: string; json: string }): void => {
    toolCalls.push({ callId: open.callId, toolName: open.toolName, args: parseToolArgs(open.json) });
  };

  for await (const ev of stream) {
    switch (ev.type) {
      case 'message_start':
        inputTokens = ev.message.usage.input_tokens;
        break;
      case 'content_block_start':
        if (ev.content_block.type === 'tool_use') {
          openTools.set(ev.index, { callId: ev.content_block.id, toolName: ev.content_block.name, json: '' });
        }
        break;
      case 'content_block_delta': {
        const delta = ev.delta;
        if (delta.type === 'text_delta') {
          text += delta.text;
          onTextDelta(delta.text);
        } else if (delta.type === 'input_json_delta') {
          const open = openTools.get(ev.index);
          if (open !== undefined) open.json += delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const open = openTools.get(ev.index);
        if (open !== undefined) {
          openTools.delete(ev.index);
          closeTool(open);
        }
        break;
      }
      case 'message_delta':
        stopReason = mapStopReason(ev.delta.stop_reason);
        outputTokens = ev.usage.output_tokens;
        break;
      case 'message_stop':
        break;
    }
  }
  // 流被提前中断时仍有未闭合的 tool_use：尽力收尾而非丢弃
  for (const open of openTools.values()) closeTool(open);

  return { text, toolCalls, stopReason, usage: { inputTokens, outputTokens } };
}
