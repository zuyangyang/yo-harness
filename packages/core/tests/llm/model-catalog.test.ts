import { describe, expect, it } from 'vitest';

import { createAnthropicCatalog, createModelCatalog, createOpenAICompatCatalog } from '../../src/llm/model-catalog.js';
import { FatalError, TransientError, ValidationError } from '../../src/types/errors.js';

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function headersOf(captured: Captured): Record<string, string> {
  return (captured.init?.headers ?? {}) as Record<string, string>;
}

describe('createOpenAICompatCatalog', () => {
  it('请求 {baseURL}/models 并带上 Bearer 头，解析 data[].id', async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-v4-pro' }] }));
    const port = createOpenAICompatCatalog({ baseURL: 'https://gateway.test/v1', apiKey: 'sk-1', fetchImpl });

    const models = await port.listModels();

    expect(models).toEqual([{ id: 'deepseek-chat' }, { id: 'deepseek-v4-pro' }]);
    expect(calls[0]?.url).toBe('https://gateway.test/v1/models');
    expect(headersOf(calls[0]!).Authorization).toBe('Bearer sk-1');
  });

  it('baseURL 末尾斜杠不会产生双斜杠', async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ data: [] }));
    await createOpenAICompatCatalog({ baseURL: 'https://gateway.test/v1/', fetchImpl }).listModels();
    expect(calls[0]?.url).toBe('https://gateway.test/v1/models');
  });

  it('无 apiKey 时不发送 Authorization 头', async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ data: [] }));
    await createOpenAICompatCatalog({ baseURL: 'https://gateway.test/v1', fetchImpl }).listModels();
    expect(headersOf(calls[0]!).Authorization).toBeUndefined();
  });

  it('非 2xx → ValidationError，带状态码', async () => {
    const { fetchImpl } = mockFetch(() => json({ error: 'unauthorized' }, 401));
    const port = createOpenAICompatCatalog({ baseURL: 'https://gateway.test/v1', fetchImpl });

    await expect(port.listModels()).rejects.toBeInstanceOf(ValidationError);
    await expect(port.listModels()).rejects.toThrow('HTTP 401');
  });

  it('网络失败 → TransientError', async () => {
    const { fetchImpl } = mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const port = createOpenAICompatCatalog({ baseURL: 'https://gateway.test/v1', fetchImpl });

    await expect(port.listModels()).rejects.toBeInstanceOf(TransientError);
  });

  it('响应非 JSON → FatalError', async () => {
    const { fetchImpl } = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
    const port = createOpenAICompatCatalog({ baseURL: 'https://gateway.test/v1', fetchImpl });

    await expect(port.listModels()).rejects.toBeInstanceOf(FatalError);
  });

  it('缺少 data 数组 → FatalError', async () => {
    const { fetchImpl } = mockFetch(() => json({ object: 'list' }));
    const port = createOpenAICompatCatalog({ baseURL: 'https://gateway.test/v1', fetchImpl });

    await expect(port.listModels()).rejects.toThrow('missing data array');
  });

  it('跳过 id 非字符串或空白的条目', async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ data: [{ id: 'ok' }, { id: 42 }, { id: '   ' }, { name: 'no-id' }, null, 'str'] }),
    );
    const port = createOpenAICompatCatalog({ baseURL: 'https://gateway.test/v1', fetchImpl });

    await expect(port.listModels()).resolves.toEqual([{ id: 'ok' }]);
  });
});

describe('createAnthropicCatalog', () => {
  it('请求 /v1/models 并带 x-api-key 与 anthropic-version', async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ data: [{ id: 'claude-sonnet-4-5' }] }));
    const port = createAnthropicCatalog({ apiKey: 'sk-ant', fetchImpl });

    const models = await port.listModels();

    expect(models).toEqual([{ id: 'claude-sonnet-4-5' }]);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models');
    expect(headersOf(calls[0]!)['x-api-key']).toBe('sk-ant');
    expect(headersOf(calls[0]!)['anthropic-version']).toBe('2023-06-01');
  });

  it('自定义 baseURL 生效', async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ data: [] }));
    await createAnthropicCatalog({ apiKey: 'sk-ant', baseURL: 'https://proxy.test', fetchImpl }).listModels();
    expect(calls[0]?.url).toBe('https://proxy.test/v1/models');
  });
});

describe('createModelCatalog', () => {
  it('anthropic 缺密钥直接拒绝', () => {
    expect(() => createModelCatalog({ kind: 'anthropic', baseURL: undefined, apiKey: undefined })).toThrow(ValidationError);
  });

  it('openai-compat 缺地址直接拒绝', () => {
    expect(() => createModelCatalog({ kind: 'openai-compat', baseURL: undefined, apiKey: 'sk-x' })).toThrow(ValidationError);
  });

  it('按 kind 分发到对应实现', async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ data: [{ id: 'm' }] }));

    await createModelCatalog({ kind: 'anthropic', baseURL: undefined, apiKey: 'k', fetchImpl }).listModels();
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models');

    await createModelCatalog({ kind: 'openai-compat', baseURL: 'https://g.test/v1', apiKey: 'k', fetchImpl }).listModels();
    expect(calls[1]?.url).toBe('https://g.test/v1/models');
  });
});
