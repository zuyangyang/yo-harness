/**
 * LLM Provider 契约测试套件（共享用例集）。
 *
 * 同一组场景 / 同一组期望值，四个实现（fake / anthropic / openai-compat / 网关）
 * 全跑 —— 保证消息模型 ↔ 各家 API 格式的互转无漂移（文档 §6.2）。
 * Provider 专属的出站格式断言（tool_result blocks / role:'tool' 等）在各自
 * 测试文件里补充；本套件只断言行为等价。
 */
import { describe, expect, it } from 'vitest';

import type { ToolCall } from '../../src/types/events.js';
import type { ChatMessage, ChatRequest, ChatResponse, LLMClient } from '../../src/types/llm.js';
import type { ToolSpec } from '../../src/types/tools.js';

export type ContractScenario =
  | 'basic'
  | 'streaming'
  | 'single_tool'
  | 'multi_tool'
  | 'tool_error'
  | 'max_tokens';

const SYSTEM = 'You are a contract-test assistant.';

export const WEATHER_SPEC: ToolSpec = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

export const READ_SPEC: ToolSpec = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

const userMsg = (text: string): ChatMessage => ({ role: 'user', text });

const assistantMsg = (text: string, toolCalls?: ToolCall[]): ChatMessage => ({
  role: 'assistant',
  text,
  ...(toolCalls === undefined ? {} : { toolCalls }),
});

const toolMsg = (callId: string, text: string, isError = false): ChatMessage => ({
  role: 'tool',
  callId,
  text,
  ...(isError ? { isError: true } : {}),
});

export function requestFor(scenario: ContractScenario): ChatRequest {
  switch (scenario) {
    case 'basic':
    case 'streaming':
    case 'max_tokens':
      return { system: SYSTEM, messages: [userMsg('Hello')], tools: [], maxTokens: 64 };
    case 'single_tool':
      return {
        system: SYSTEM,
        messages: [userMsg('What is the weather in Beijing?')],
        tools: [WEATHER_SPEC],
        maxTokens: 64,
      };
    case 'multi_tool':
      return {
        system: SYSTEM,
        messages: [userMsg('What is the weather in Beijing and Shanghai?')],
        tools: [WEATHER_SPEC],
        maxTokens: 64,
      };
    case 'tool_error':
      return {
        system: SYSTEM,
        messages: [
          userMsg('Read foo.txt for me'),
          assistantMsg('', [
            { callId: 'call_9', toolName: 'read_file', args: { path: 'foo.txt' } },
          ]),
          toolMsg('call_9', 'File not found: foo.txt', true),
        ],
        tools: [READ_SPEC],
        maxTokens: 64,
      };
  }
}

/** 各场景的期望 ChatResponse —— Provider 侧的 mock 必须编排出同样的值 */
export const EXPECTED = {
  basic: {
    text: 'Hello! How can I help?',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 12, outputTokens: 8 },
  },
  streaming: {
    text: 'Streaming works nicely!',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 12, outputTokens: 8 },
  },
  single_tool: {
    text: '',
    toolCalls: [{ callId: 'call_1', toolName: 'get_weather', args: { city: 'Beijing' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 20, outputTokens: 15 },
  },
  multi_tool_first: {
    text: '',
    toolCalls: [
      { callId: 'call_1', toolName: 'get_weather', args: { city: 'Beijing' } },
      { callId: 'call_2', toolName: 'get_weather', args: { city: 'Shanghai' } },
    ],
    stopReason: 'tool_use',
    usage: { inputTokens: 20, outputTokens: 25 },
  },
  multi_tool_second: {
    text: 'Beijing is 22°C. Shanghai lookup failed.',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 30, outputTokens: 12 },
  },
  tool_error: {
    text: 'The file is missing, so I will create it instead.',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 25, outputTokens: 10 },
  },
  max_tokens: {
    text: 'The answer is',
    toolCalls: [],
    stopReason: 'max_tokens',
    usage: { inputTokens: 12, outputTokens: 64 },
  },
} satisfies Record<string, ChatResponse>;

export function runLLMContractSuite(
  label: string,
  setup: (scenario: ContractScenario) => LLMClient,
): void {
  describe(`LLM contract: ${label}`, () => {
    it('基本对话：返回文本与用量', async () => {
      const res = await setup('basic').chat(requestFor('basic'));
      expect(res).toEqual(EXPECTED.basic);
    });

    it('流式：onTextDelta 拼接等于最终文本', async () => {
      const deltas: string[] = [];
      const res = await setup('streaming').chat(requestFor('streaming'), {
        onTextDelta: (delta) => {
          deltas.push(delta);
        },
      });
      expect(res).toEqual(EXPECTED.streaming);
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      expect(deltas.join('')).toBe(EXPECTED.streaming.text);
    });

    it('单工具调用：解析 callId / 工具名 / 参数', async () => {
      const res = await setup('single_tool').chat(requestFor('single_tool'));
      expect(res).toEqual(EXPECTED.single_tool);
    });

    it('多工具并行：结果回传后正常收尾', async () => {
      const client = setup('multi_tool');
      const first = await client.chat(requestFor('multi_tool'));
      expect(first).toEqual(EXPECTED.multi_tool_first);

      const followUp: ChatRequest = {
        ...requestFor('multi_tool'),
        messages: [
          ...requestFor('multi_tool').messages,
          assistantMsg('', EXPECTED.multi_tool_first.toolCalls),
          toolMsg('call_1', '{"tempC":22}'),
          toolMsg('call_2', 'city not found', true),
        ],
      };
      const second = await client.chat(followUp);
      expect(second).toEqual(EXPECTED.multi_tool_second);
    });

    it('工具错误回传：isError 结果后正常收尾', async () => {
      const res = await setup('tool_error').chat(requestFor('tool_error'));
      expect(res).toEqual(EXPECTED.tool_error);
    });

    it('max_tokens：stopReason 映射正确', async () => {
      const res = await setup('max_tokens').chat(requestFor('max_tokens'));
      expect(res).toEqual(EXPECTED.max_tokens);
    });
  });
}
