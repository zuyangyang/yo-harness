/**
 * OpenAI 兼容适配器测试。
 *
 * 两部分：
 * 1. 共享契约套件 —— mock transport 编排出与 EXPECTED 一致的 SDK 形状；
 * 2. 适配器专属 —— 出站转换（system 首条 / role:'tool' / content:null / JSON 参数）、
 *    流式 tool_call 分片按 index 累积、stream_options、错误分类矩阵。
 * 全程零网络：mock 实现 OpenAICompatTransport。
 */
import { describe, expect, it } from 'vitest';
import type OpenAI from 'openai';

import { OpenAICompatLLMClient } from '../../../src/llm/providers/openai-compat.js';
import type { OpenAICompatTransport } from '../../../src/llm/providers/openai-compat.js';
import { FatalError, TransientError, ValidationError } from '../../../src/types/errors.js';
import { EXPECTED, requestFor, runLLMContractSuite, WEATHER_SPEC } from '../contract.js';
import type { ContractScenario } from '../contract.js';

// ---------------------------------------------------------------------------
// SDK 形状构造器
// ---------------------------------------------------------------------------

function chunkUsage(prompt: number, completion: number): OpenAI.CompletionUsage {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function fnToolCall(
  id: string,
  name: string,
  args: string,
): OpenAI.Chat.ChatCompletionMessageFunctionToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function completion(
  content: string | null,
  toolCalls: readonly OpenAI.Chat.ChatCompletionMessageFunctionToolCall[],
  finishReason: OpenAI.Chat.ChatCompletion.Choice['finish_reason'],
  u?: OpenAI.CompletionUsage,
): OpenAI.Chat.ChatCompletion {
  return {
    id: 'cmpl_mock',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          refusal: null,
          ...(toolCalls.length > 0 ? { tool_calls: [...toolCalls] } : {}),
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    created: 123,
    model: 'mock-model',
    object: 'chat.completion',
    ...(u !== undefined ? { usage: u } : {}),
  };
}

function chunk(
  delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta,
  finishReason: OpenAI.Chat.ChatCompletionChunk.Choice['finish_reason'],
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'cmpl_mock',
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    created: 123,
    model: 'mock-model',
    object: 'chat.completion.chunk',
  };
}

/** stream_options.include_usage 开启时的 usage-only 最终 chunk（choices 为空） */
function usageOnlyChunk(u: OpenAI.CompletionUsage): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'cmpl_mock',
    choices: [],
    created: 123,
    model: 'mock-model',
    object: 'chat.completion.chunk',
    usage: u,
  };
}

// ---------------------------------------------------------------------------
// Mock transport：脚本化响应队列 + 请求记录
// ---------------------------------------------------------------------------

type MockResponse = OpenAI.Chat.ChatCompletion | OpenAI.Chat.ChatCompletionChunk[];

class MockOpenAICompatTransport implements OpenAICompatTransport {
  readonly created: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming[] = [];
  readonly streamed: OpenAI.Chat.ChatCompletionCreateParamsStreaming[] = [];
  private readonly queue: MockResponse[] = [];
  failWith: Error | null = null;

  enqueue(res: MockResponse): void {
    this.queue.push(res);
  }

  create(params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.ChatCompletion> {
    this.created.push(params);
    if (this.failWith !== null) throw this.failWith;
    const next = this.queue.shift();
    if (next === undefined || Array.isArray(next)) {
      throw new Error('mock: no non-streaming response queued');
    }
    return Promise.resolve(next);
  }

  createStream(
    params: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    this.streamed.push(params);
    if (this.failWith !== null) throw this.failWith;
    const next = this.queue.shift();
    if (next === undefined || !Array.isArray(next)) {
      throw new Error('mock: no stream response queued');
    }
    const chunks = next;
    return Promise.resolve(
      (async function* (): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
        for (const c of chunks) yield c;
      })(),
    );
  }
}

// ---------------------------------------------------------------------------
// 契约套件接线
// ---------------------------------------------------------------------------

function clientFor(scenario: ContractScenario): OpenAICompatLLMClient {
  const transport = new MockOpenAICompatTransport();
  switch (scenario) {
    case 'basic':
      transport.enqueue(completion(EXPECTED.basic.text, [], 'stop', chunkUsage(12, 8)));
      break;
    case 'streaming':
      transport.enqueue([
        chunk({ content: 'Streaming works' }, null),
        chunk({ content: ' nicely!' }, 'stop'),
        usageOnlyChunk(chunkUsage(12, 8)),
      ]);
      break;
    case 'single_tool':
      transport.enqueue(
        completion(null, [fnToolCall('call_1', 'get_weather', '{"city":"Beijing"}')], 'tool_calls', chunkUsage(20, 15)),
      );
      break;
    case 'multi_tool':
      transport.enqueue(
        completion(
          null,
          [
            fnToolCall('call_1', 'get_weather', '{"city":"Beijing"}'),
            fnToolCall('call_2', 'get_weather', '{"city":"Shanghai"}'),
          ],
          'tool_calls',
          chunkUsage(20, 25),
        ),
      );
      transport.enqueue(completion(EXPECTED.multi_tool_second.text, [], 'stop', chunkUsage(30, 12)));
      break;
    case 'tool_error':
      transport.enqueue(completion(EXPECTED.tool_error.text, [], 'stop', chunkUsage(25, 10)));
      break;
    case 'max_tokens':
      transport.enqueue(completion('The answer is', [], 'length', chunkUsage(12, 64)));
      break;
  }
  return new OpenAICompatLLMClient(transport, 'mock-model');
}

runLLMContractSuite('openai-compat', clientFor);

// ---------------------------------------------------------------------------
// 适配器专属行为
// ---------------------------------------------------------------------------

describe('OpenAICompatLLMClient', () => {
  it('工厂：可自定义 provider 名（网关注册键）', () => {
    const client = OpenAICompatLLMClient.create({ name: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key' });
    expect(client.name).toBe('deepseek');
  });

  it('无 onTextDelta 走非流式 create；无工具时不携带 tools 字段', async () => {
    const transport = new MockOpenAICompatTransport();
    transport.enqueue(completion('a', [], 'stop', chunkUsage(1, 1)));
    const client = new OpenAICompatLLMClient(transport, 'mock-model');

    await client.chat(requestFor('basic'));

    expect(transport.created).toHaveLength(1);
    expect(transport.streamed).toHaveLength(0);
    expect(transport.created[0]?.stream).toBe(false);
    expect(transport.created[0]?.tools).toBeUndefined();
  });

  it('流式请求携带 stream:true 与 stream_options.include_usage', async () => {
    const transport = new MockOpenAICompatTransport();
    transport.enqueue([chunk({ content: 'x' }, 'stop'), usageOnlyChunk(chunkUsage(1, 1))]);
    const client = new OpenAICompatLLMClient(transport, 'mock-model');

    await client.chat(requestFor('basic'), { onTextDelta: () => undefined });

    expect(transport.streamed).toHaveLength(1);
    expect(transport.streamed[0]?.stream).toBe(true);
    expect(transport.streamed[0]?.stream_options).toEqual({ include_usage: true });
    expect(transport.streamed[0]?.model).toBe('mock-model');
    expect(transport.streamed[0]?.max_tokens).toBe(64);
  });

  it('出站转换：system 首条；assistant 空文本+tool_calls → content:null + JSON 参数；tool 结果独立消息', async () => {
    const transport = new MockOpenAICompatTransport();
    transport.enqueue(completion('ok', [], 'stop', chunkUsage(1, 1)));
    const client = new OpenAICompatLLMClient(transport, 'mock-model');

    await client.chat({
      system: 'S',
      messages: [
        { role: 'user', text: 'go' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            { callId: 'c1', toolName: 'get_weather', args: { city: 'X' } },
            { callId: 'c2', toolName: 'get_weather', args: {} },
          ],
        },
        { role: 'tool', callId: 'c1', text: 'r1' },
        { role: 'tool', callId: 'c2', text: 'city not found', isError: true },
      ],
      tools: [WEATHER_SPEC],
      maxTokens: 32,
    });

    expect(transport.created[0]?.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"X"}' } },
          { id: 'c2', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'city not found' },
    ]);
    expect(transport.created[0]?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ]);
  });

  it('出站转换：assistant 有文本时 content 为文本本身', async () => {
    const transport = new MockOpenAICompatTransport();
    transport.enqueue(completion('ok', [], 'stop', chunkUsage(1, 1)));
    const client = new OpenAICompatLLMClient(transport, 'mock-model');

    await client.chat({
      system: 'S',
      messages: [
        { role: 'user', text: 'go' },
        { role: 'assistant', text: 'checking', toolCalls: [{ callId: 'c1', toolName: 't', args: {} }] },
      ],
      tools: [WEATHER_SPEC],
      maxTokens: 32,
    });

    expect(transport.created[0]?.messages[2]).toEqual({
      role: 'assistant',
      content: 'checking',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
    });
  });

  it('流式 tool_call：分片按 index 累积（含交错分片），结果按 index 排序', async () => {
    const transport = new MockOpenAICompatTransport();
    transport.enqueue([
      chunk(
        {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }],
        },
        null,
      ),
      chunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city"' } }] }, null),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Beijing"' } }] }, null),
      chunk({ tool_calls: [{ index: 1, function: { arguments: ':"Shanghai"}' } }] }, null),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }, null),
      chunk({}, 'tool_calls'),
      usageOnlyChunk(chunkUsage(20, 25)),
    ]);
    const client = new OpenAICompatLLMClient(transport, 'mock-model');

    const res = await client.chat(requestFor('single_tool'), { onTextDelta: () => undefined });

    expect(res.toolCalls).toEqual([
      { callId: 'call_1', toolName: 'get_weather', args: { city: 'Beijing' } },
      { callId: 'call_2', toolName: 'get_weather', args: { city: 'Shanghai' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 25 });
  });

  it('非 function 类型的 tool_call → ValidationError', async () => {
    const transport = new MockOpenAICompatTransport();
    transport.enqueue({
      id: 'cmpl_mock',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [{ id: 'custom_x', type: 'custom', custom: { name: 'weird', input: '' } }],
          },
          finish_reason: 'tool_calls',
          logprobs: null,
        },
      ],
      created: 123,
      model: 'mock-model',
      object: 'chat.completion',
    });
    const client = new OpenAICompatLLMClient(transport, 'mock-model');

    await expect(client.chat(requestFor('basic'))).rejects.toBeInstanceOf(ValidationError);
  });

  it('空 choices → FatalError；缺失 usage → 0/0', async () => {
    const transport = new MockOpenAICompatTransport();
    transport.enqueue({
      id: 'cmpl_mock',
      choices: [],
      created: 123,
      model: 'mock-model',
      object: 'chat.completion',
    });
    transport.enqueue(completion('no usage field', [], 'stop'));
    const client = new OpenAICompatLLMClient(transport, 'mock-model');

    await expect(client.chat(requestFor('basic'))).rejects.toBeInstanceOf(FatalError);

    const res = await client.chat(requestFor('basic'));
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('finish_reason 归一：content_filter→end_turn；畸形 arguments → ValidationError', async () => {
    const transport = new MockOpenAICompatTransport();
    transport.enqueue(completion('filtered', [], 'content_filter', chunkUsage(1, 1)));
    transport.enqueue(completion(null, [fnToolCall('call_x', 't', '{"broken"')], 'tool_calls', chunkUsage(1, 1)));
    const client = new OpenAICompatLLMClient(transport, 'mock-model');

    expect((await client.chat(requestFor('basic'))).stopReason).toBe('end_turn');
    await expect(client.chat(requestFor('basic'))).rejects.toBeInstanceOf(ValidationError);
  });

  it('错误分类：429/500/408→Transient，400/422→Validation，401→Fatal，连接错误→Transient', async () => {
    const connectionError = new Error('connection error');
    connectionError.name = 'APIConnectionTimeoutError';
    const matrix: readonly [Error, typeof TransientError | typeof ValidationError | typeof FatalError][] = [
      [Object.assign(new Error('rate limited'), { status: 429 }), TransientError],
      [Object.assign(new Error('internal'), { status: 502 }), TransientError],
      [Object.assign(new Error('timeout'), { status: 408 }), TransientError],
      [connectionError, TransientError],
      [Object.assign(new Error('bad request'), { status: 400 }), ValidationError],
      [Object.assign(new Error('unprocessable'), { status: 422 }), ValidationError],
      [Object.assign(new Error('unauthorized'), { status: 401 }), FatalError],
      [Object.assign(new Error('forbidden'), { status: 403 }), FatalError],
    ];

    for (const [err, expectedClass] of matrix) {
      const transport = new MockOpenAICompatTransport();
      transport.failWith = err;
      const client = new OpenAICompatLLMClient(transport, 'mock-model');
      await expect(client.chat(requestFor('basic'))).rejects.toBeInstanceOf(expectedClass);
    }
  });
});
