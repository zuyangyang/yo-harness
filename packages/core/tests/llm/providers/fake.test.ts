import { describe, expect, it } from 'vitest';

import type { ChatResponse } from '../../../src/types/llm.js';
import { FakeLLMClient } from '../../../src/llm/providers/fake.js';
import {
  EXPECTED,
  requestFor,
  runLLMContractSuite,
  type ContractScenario,
} from '../contract.js';

/** 按场景编排 fake 脚本 —— 与其他 Provider 的 mock 编排同一个期望值 */
function scriptedClient(scenario: ContractScenario): FakeLLMClient {
  const script: Record<ContractScenario, ChatResponse[]> = {
    basic: [EXPECTED.basic],
    streaming: [EXPECTED.streaming],
    single_tool: [EXPECTED.single_tool],
    multi_tool: [EXPECTED.multi_tool_first, EXPECTED.multi_tool_second],
    tool_error: [EXPECTED.tool_error],
    max_tokens: [EXPECTED.max_tokens],
  };
  return new FakeLLMClient(script[scenario]);
}

runLLMContractSuite('fake', scriptedClient);

describe('FakeLLMClient', () => {
  it('按顺序返回脚本响应并记录请求', async () => {
    const client = new FakeLLMClient([
      { text: 'first', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'second', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const req = requestFor('basic');

    expect((await client.chat(req)).text).toBe('first');
    expect((await client.chat(req)).text).toBe('second');
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.system).toBe(req.system);
    expect(client.consumed).toBe(2);
  });

  it('脚本耗尽抛 FatalError', async () => {
    const client = new FakeLLMClient([]);
    await expect(client.chat(requestFor('basic'))).rejects.toThrow(/script exhausted/);
    expect(client.consumed).toBe(0);
  });

  it('空 text 不触发 onTextDelta', async () => {
    const deltas: string[] = [];
    const client = new FakeLLMClient([
      { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    await client.chat(requestFor('basic'), { onTextDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual([]);
  });

  it('fromScriptLines 解析 NDJSON 并应用默认值', async () => {
    const raw = [
      '{"text":"你好"}',
      '{"toolCalls":[{"callId":"c1","toolName":"get_weather","args":{"city":"Beijing"}}]}',
      '',
      '{"text":"done","usage":{"inputTokens":5,"outputTokens":6}}',
    ].join('\n');
    const client = FakeLLMClient.fromScriptLines(raw);
    const req = requestFor('basic');

    expect((await client.chat(req))).toMatchObject({
      text: '你好',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    expect((await client.chat(req))).toMatchObject({
      text: '',
      toolCalls: [{ callId: 'c1', toolName: 'get_weather', args: { city: 'Beijing' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    expect((await client.chat(req))).toMatchObject({
      text: 'done',
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 6 },
    });
  });

  it('fromScriptLines 坏行抛 ValidationError 且带行号', () => {
    expect(() => FakeLLMClient.fromScriptLines('{"text":"ok"}\n{not json')).toThrow(
      /line 2.*invalid JSON/,
    );
    expect(() => FakeLLMClient.fromScriptLines('{"text":123}')).toThrow(/line 1/);
  });

  it('fromEnv：未设置返回 undefined；设置时按脚本构造', async () => {
    expect(FakeLLMClient.fromEnv({})).toBeUndefined();
    expect(FakeLLMClient.fromEnv({ YO_FAKE_SCRIPT: '   ' })).toBeUndefined();

    const client = FakeLLMClient.fromEnv({ YO_FAKE_SCRIPT: '{"text":"from env"}' });
    expect(client).toBeDefined();
    expect((await client?.chat(requestFor('basic')))?.text).toBe('from env');
  });
});
