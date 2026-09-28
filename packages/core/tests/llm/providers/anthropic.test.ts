/**
 * Anthropic 适配器测试。
 *
 * 两部分：
 * 1. 共享契约套件 —— mock transport 编排出与 EXPECTED 一致的 SDK 形状；
 * 2. 适配器专属 —— 出站消息转换（tool_result 合并）、流式 tool_use 累积、
 *    错误分类矩阵、流式/非流式路由。
 * 全程零网络：mock 实现 AnthropicTransport，直接产出 SDK 类型形状。
 */
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

import { AnthropicLLMClient } from '../../../src/llm/providers/anthropic.js';
import type { AnthropicTransport } from '../../../src/llm/providers/anthropic.js';
import { FatalError, TransientError, ValidationError } from '../../../src/types/errors.js';
import { EXPECTED, requestFor, runLLMContractSuite, WEATHER_SPEC } from '../contract.js';
import type { ContractScenario } from '../contract.js';

// ---------------------------------------------------------------------------
// SDK 形状构造器（只填契约路径会用到的字段，其余为协议要求的 null）
// ---------------------------------------------------------------------------

function usage(inputTokens: number, outputTokens: number): Anthropic.Usage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

function messageDeltaUsage(outputTokens: number): Anthropic.MessageDeltaUsage {
  return {
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    input_tokens: null,
    output_tokens: outputTokens,
    output_tokens_details: null,
    server_tool_use: null,
  };
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null };
}

function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id, name, input, caller: { type: 'direct' } };
}

function message(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message['stop_reason'],
  u: Anthropic.Usage,
): Anthropic.Message {
  return {
    id: 'msg_mock',
    container: null,
    content,
    model: 'claude-mock',
    role: 'assistant',
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: 'message',
    usage: u,
  };
}

/** 文本流：chunks 逐段 text_delta */
function textStream(
  chunks: readonly string[],
  stopReason: Anthropic.Message['stop_reason'],
  u: { input: number; output: number },
): Anthropic.RawMessageStreamEvent[] {
  const events: Anthropic.RawMessageStreamEvent[] = [
    { type: 'message_start', message: message([], stopReason, usage(u.input, 0)) },
  ];
  chunks.forEach((chunk, index) => {
    events.push({ type: 'content_block_start', content_block: textBlock(''), index });
    events.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: chunk }, index });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
    usage: messageDeltaUsage(u.output),
  });
  events.push({ type: 'message_stop' });
  return events;
}

/** 工具调用流：input_json_delta 分片累积 */
function toolUseStream(
  calls: readonly { id: string; name: string; jsonChunks: readonly string[] }[],
  stopReason: Anthropic.Message['stop_reason'],
  u: { input: number; output: number },
): Anthropic.RawMessageStreamEvent[] {
  const events: Anthropic.RawMessageStreamEvent[] = [
    { type: 'message_start', message: message([], stopReason, usage(u.input, 0)) },
  ];
  calls.forEach((call, index) => {
    events.push({ type: 'content_block_start', content_block: toolUseBlock(call.id, call.name, {}), index });
    for (const json of call.jsonChunks) {
      events.push({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: json }, index });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
    usage: messageDeltaUsage(u.output),
  });
  events.push({ type: 'message_stop' });
  return events;
}

// ---------------------------------------------------------------------------
// Mock transport：脚本化响应队列 + 请求记录
// ---------------------------------------------------------------------------

type MockResponse = Anthropic.Message | Anthropic.RawMessageStreamEvent[];

class MockAnthropicTransport implements AnthropicTransport {
  readonly created: Anthropic.MessageCreateParamsNonStreaming[] = [];
  readonly streamed: Anthropic.MessageCreateParamsStreaming[] = [];
  private readonly queue: MockResponse[] = [];
  failWith: Error | null = null;

  enqueue(res: MockResponse): void {
    this.queue.push(res);
  }

  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.created.push(params);
    if (this.failWith !== null) throw this.failWith;
    const next = this.queue.shift();
    if (next === undefined || Array.isArray(next)) {
      throw new Error('mock: no non-streaming response queued');
    }
    return Promise.resolve(next);
  }

  createStream(
    params: Anthropic.MessageCreateParamsStreaming,
  ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>> {
    this.streamed.push(params);
    if (this.failWith !== null) throw this.failWith;
    const next = this.queue.shift();
    if (next === undefined || !Array.isArray(next)) {
      throw new Error('mock: no stream response queued');
    }
    const events = next;
    return Promise.resolve(
      // eslint-disable-next-line @typescript-eslint/require-await -- 测试替身，同步脚本化
      (async function* (): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
        for (const ev of events) yield ev;
      })(),
    );
  }
}

// ---------------------------------------------------------------------------
// 契约套件接线
// ---------------------------------------------------------------------------

function clientFor(scenario: ContractScenario): AnthropicLLMClient {
  const transport = new MockAnthropicTransport();
  switch (scenario) {
    case 'basic':
      transport.enqueue(message([textBlock(EXPECTED.basic.text)], 'end_turn', usage(12, 8)));
      break;
    case 'streaming':
      transport.enqueue(textStream(['Streaming works', ' nicely!'], 'end_turn', { input: 12, output: 8 }));
      break;
    case 'single_tool':
      transport.enqueue(
        message([toolUseBlock('call_1', 'get_weather', { city: 'Beijing' })], 'tool_use', usage(20, 15)),
      );
      break;
    case 'multi_tool':
      transport.enqueue(
        message(
          [
            toolUseBlock('call_1', 'get_weather', { city: 'Beijing' }),
            toolUseBlock('call_2', 'get_weather', { city: 'Shanghai' }),
          ],
          'tool_use',
          usage(20, 25),
        ),
      );
      transport.enqueue(
        message([textBlock(EXPECTED.multi_tool_second.text)], 'end_turn', usage(30, 12)),
      );
      break;
    case 'tool_error':
      transport.enqueue(message([textBlock(EXPECTED.tool_error.text)], 'end_turn', usage(25, 10)));
      break;
    case 'max_tokens':
      transport.enqueue(message([textBlock('The answer is')], 'max_tokens', usage(12, 64)));
      break;
  }
  return new AnthropicLLMClient(transport, 'claude-mock');
}

runLLMContractSuite('anthropic', clientFor);

// ---------------------------------------------------------------------------
// 适配器专属行为
// ---------------------------------------------------------------------------

describe('AnthropicLLMClient', () => {
  it('无 onTextDelta 走非流式 create，有则走 createStream', async () => {
    const transport = new MockAnthropicTransport();
    transport.enqueue(message([textBlock('a')], 'end_turn', usage(1, 1)));
    transport.enqueue(textStream(['b'], 'end_turn', { input: 1, output: 1 }));
    const client = new AnthropicLLMClient(transport, 'claude-mock');
    const req = requestFor('basic');

    await client.chat(req);
    expect(transport.created).toHaveLength(1);
    expect(transport.created[0]?.stream).toBe(false);
    expect(transport.streamed).toHaveLength(0);

    await client.chat(req, { onTextDelta: () => undefined });
    expect(transport.streamed).toHaveLength(1);
    expect(transport.streamed[0]?.stream).toBe(true);
  });

  it('出站转换：连续 tool 消息合并为单条 user tool_result blocks；is_error 映射', async () => {
    const transport = new MockAnthropicTransport();
    transport.enqueue(message([textBlock('ok')], 'end_turn', usage(1, 1)));
    const client = new AnthropicLLMClient(transport, 'claude-mock');

    await client.chat({
      system: 'S',
      messages: [
        { role: 'user', text: 'weather?' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ callId: 'c1', toolName: 'get_weather', args: { city: 'X' } }],
        },
        { role: 'tool', callId: 'c1', text: 'r1' },
        { role: 'tool', callId: 'c2', text: 'city not found', isError: true },
      ],
      tools: [WEATHER_SPEC],
      maxTokens: 32,
    });

    expect(transport.created[0]?.system).toBe('S');
    expect(transport.created[0]?.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'get_weather', input: { city: 'X' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
          { type: 'tool_result', tool_use_id: 'c2', content: 'city not found', is_error: true },
        ],
      },
    ]);
    expect(transport.created[0]?.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ]);
  });

  it('出站转换：assistant 有文本 + 工具调用时同时携带 text 与 tool_use blocks', async () => {
    const transport = new MockAnthropicTransport();
    transport.enqueue(message([textBlock('ok')], 'end_turn', usage(1, 1)));
    const client = new AnthropicLLMClient(transport, 'claude-mock');

    await client.chat({
      system: 'S',
      messages: [
        { role: 'user', text: 'go' },
        {
          role: 'assistant',
          text: 'checking',
          toolCalls: [{ callId: 'c1', toolName: 'get_weather', args: {} }],
        },
      ],
      tools: [WEATHER_SPEC],
      maxTokens: 32,
    });

    expect(transport.created[0]?.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'c1', name: 'get_weather', input: {} },
      ],
    });
  });

  it('流式 tool_use：input_json_delta 分片累积并在 block 结束时解析', async () => {
    const transport = new MockAnthropicTransport();
    transport.enqueue(
      toolUseStream(
        [{ id: 'call_1', name: 'get_weather', jsonChunks: ['{"ci', 'ty":"Bei', 'jing"}'] }],
        'tool_use',
        { input: 20, output: 15 },
      ),
    );
    const client = new AnthropicLLMClient(transport, 'claude-mock');

    const res = await client.chat(requestFor('single_tool'), { onTextDelta: () => undefined });

    expect(res.toolCalls).toEqual([{ callId: 'call_1', toolName: 'get_weather', args: { city: 'Beijing' } }]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 15 });
  });

  it('流式时请求携带 stream:true 且透传 model / max_tokens / tools', async () => {
    const transport = new MockAnthropicTransport();
    transport.enqueue(textStream(['x'], 'end_turn', { input: 1, output: 1 }));
    const client = new AnthropicLLMClient(transport, 'claude-3-mock');

    await client.chat(requestFor('single_tool'), { onTextDelta: () => undefined });

    expect(transport.streamed[0]?.model).toBe('claude-3-mock');
    expect(transport.streamed[0]?.max_tokens).toBe(64);
    expect(transport.streamed[0]?.tools).toHaveLength(1);
  });

  it('错误分类：429/500/408→Transient，400/422→Validation，401→Fatal，连接错误→Transient', async () => {
    const connectionError = new Error('socket hang up');
    connectionError.name = 'APIConnectionError';
    const matrix: readonly [Error, typeof TransientError | typeof ValidationError | typeof FatalError][] = [
      [Object.assign(new Error('rate limited'), { status: 429 }), TransientError],
      [Object.assign(new Error('internal'), { status: 500 }), TransientError],
      [Object.assign(new Error('timeout'), { status: 408 }), TransientError],
      [connectionError, TransientError],
      [Object.assign(new Error('bad request'), { status: 400 }), ValidationError],
      [Object.assign(new Error('unprocessable'), { status: 422 }), ValidationError],
      [Object.assign(new Error('unauthorized'), { status: 401 }), FatalError],
      [Object.assign(new Error('forbidden'), { status: 403 }), FatalError],
    ];

    for (const [err, expectedClass] of matrix) {
      const transport = new MockAnthropicTransport();
      transport.failWith = err;
      const client = new AnthropicLLMClient(transport, 'claude-mock');
      await expect(client.chat(requestFor('basic'))).rejects.toBeInstanceOf(expectedClass);
    }
  });

  it('AppError 原样透传（不被二次包装）', async () => {
    const transport = new MockAnthropicTransport();
    transport.failWith = new ValidationError('already classified');
    const client = new AnthropicLLMClient(transport, 'claude-mock');

    await expect(client.chat(requestFor('basic'))).rejects.toThrow('already classified');
  });

  it('畸形 tool arguments → ValidationError（不可重试）', async () => {
    const transport = new MockAnthropicTransport();
    transport.enqueue(
      toolUseStream([{ id: 'call_1', name: 'get_weather', jsonChunks: ['{"city":'] }], 'tool_use', {
        input: 20,
        output: 15,
      }),
    );
    const client = new AnthropicLLMClient(transport, 'claude-mock');

    await expect(client.chat(requestFor('single_tool'), { onTextDelta: () => undefined })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('stop_reason 非白名单值（pause_turn / null）归一为 end_turn', async () => {
    const transport = new MockAnthropicTransport();
    transport.enqueue(message([textBlock('paused')], 'pause_turn', usage(1, 1)));
    transport.enqueue(message([textBlock('null reason')], null, usage(1, 1)));
    const client = new AnthropicLLMClient(transport, 'claude-mock');

    expect((await client.chat(requestFor('basic'))).stopReason).toBe('end_turn');
    expect((await client.chat(requestFor('basic'))).stopReason).toBe('end_turn');
  });
});
