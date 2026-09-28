import { describe, expect, it } from 'vitest';

import type { WebSearchSettings } from '../../src/tools/web.js';
import {
  createWebFetchTool,
  createWebSearchTool,
  htmlToText,
  isPrivateAddress,
} from '../../src/tools/web.js';
import { makeCtx } from './helpers.js';

// ---------------------------------------------------------------------------
// 测试设施
// ---------------------------------------------------------------------------

const PUBLIC_ADDRS = ['93.184.216.34'];
const okLookup = (): Promise<string[]> => Promise.resolve(PUBLIC_ADDRS);

/** 不可外访时才应该碰 DNS；被调用即说明顺序错了 */
const bombLookup = (): Promise<string[]> =>
  Promise.reject(new Error('lookup must not be called'));

/** fetch 的 input 可能是 Request 对象，取其 url 而非默认字符串化 */
const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

/** 依次返回预设 Response 的假 fetch，并记录调用 */
function recordingFetch(
  responses: Response[],
): { fetch: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push({ url: urlOf(input), init });
    const res = responses.shift();
    if (res === undefined) return Promise.reject(new Error('unexpected extra fetch call'));
    return Promise.resolve(res);
  };
  return { fetch: impl, calls };
}

const textRes = (body: string, type = 'text/plain'): Response =>
  new Response(body, { status: 200, headers: { 'content-type': type } });

const redirectRes = (location: string): Response =>
  new Response('', { status: 302, headers: { location } });

// ---------------------------------------------------------------------------
// isPrivateAddress
// ---------------------------------------------------------------------------

describe('isPrivateAddress', () => {
  it('公网地址返回 false', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '93.184.216.34']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('私网/环回/链路本地返回 true', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // 云元数据端点
      '0.0.0.0',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fdab::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    // IPv4-mapped IPv6 归一化后同查
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('无法识别的按私网处理（保守）', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

describe('htmlToText', () => {
  it('去掉 script/style/注释/标签并解码实体', () => {
    const html = [
      '<html><head><style>body{color:red}</style></head>',
      '<body>',
      '<h1>Title &amp; More</h1>',
      '<script>alert("x")</script>',
      '<p>Hello &lt;world&gt;&#39;s &#x41;</p>',
      '<!-- a comment -->',
      '</body></html>',
    ].join('\n');
    const text = htmlToText(html);
    // 注意：不能断言"全文无尖括号"——解码后的 &lt;world&gt; 合法地包含 <>
    expect(text).not.toContain('<h1>');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('<style>');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('alert');
    expect(text).toContain("Title & More");
    expect(text).toContain("Hello <world>'s A");
  });

  it('块级标签转换行，空白折叠', () => {
    const text = htmlToText('<p>one</p><p>two</p><div>three</div>');
    expect(text.split('\n')).toEqual(['one', 'two', 'three']);
  });
});

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

describe('web_fetch', () => {
  it('公网域名：DNS 全公网 → 放行并返回文本', async () => {
    const { fetch, calls } = recordingFetch([textRes('hello world')]);
    const tool = createWebFetchTool({ lookup: okLookup, fetchImpl: fetch });

    const res = await tool.run({ url: 'https://example.com/page' }, makeCtx('/tmp'));
    expect(res.ok).toBe(true);
    expect(res.content).toBe('hello world');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.com/page');
  });

  it('DNS 解析出私网地址 → 阻断且不发起 fetch', async () => {
    const { fetch, calls } = recordingFetch([]);
    const tool = createWebFetchTool({
      lookup: () => Promise.resolve(['10.0.0.5']),
      fetchImpl: fetch,
    });

    const res = await tool.run({ url: 'http://internal.example.com/admin' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/web_fetch blocked: internal\.example\.com resolves to 10\.0\.0\.5/);
    expect(calls).toHaveLength(0);
  });

  it('localhost 域名解析到 127.0.0.1 → 阻断', async () => {
    const tool = createWebFetchTool({
      lookup: () => Promise.resolve(['127.0.0.1']),
      fetchImpl: recordingFetch([]).fetch,
    });
    const res = await tool.run({ url: 'http://localhost:8080/debug' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/blocked/);
  });

  it('私网 IP 字面量 → 直接阻断（不做 DNS）', async () => {
    const tool = createWebFetchTool({
      lookup: bombLookup,
      fetchImpl: recordingFetch([]).fetch,
    });
    for (const url of [
      'http://192.168.1.1/router',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x',
    ]) {
      const res = await tool.run({ url }, makeCtx('/tmp'));
      expect(res.ok, url).toBe(false);
      expect(res.content, url).toMatch(/blocked/);
    }
  });

  it('公网 IP 字面量 → 放行（无需 DNS）', async () => {
    const { fetch, calls } = recordingFetch([textRes('dns info')]);
    const tool = createWebFetchTool({ lookup: bombLookup, fetchImpl: fetch });
    const res = await tool.run({ url: 'http://8.8.8.8/x' }, makeCtx('/tmp'));
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('重定向到私网 → 阻断在第一跳之后', async () => {
    const { fetch } = recordingFetch([redirectRes('http://10.0.0.1/steal')]);
    const tool = createWebFetchTool({ lookup: okLookup, fetchImpl: fetch });
    const res = await tool.run({ url: 'https://public.example/a' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/blocked/);
  });

  it('重定向链（含相对路径）到公网 → 跟随并返回最终内容', async () => {
    const { fetch, calls } = recordingFetch([
      redirectRes('/page2'),
      textRes('final content'),
    ]);
    const tool = createWebFetchTool({ lookup: okLookup, fetchImpl: fetch });
    const res = await tool.run({ url: 'https://public.example/page1' }, makeCtx('/tmp'));
    expect(res.ok).toBe(true);
    expect(res.content).toBe('final content');
    expect(calls.map((c) => c.url)).toEqual([
      'https://public.example/page1',
      'https://public.example/page2',
    ]);
  });

  it('超过 3 跳重定向 → 拒绝', async () => {
    const { fetch } = recordingFetch([
      redirectRes('/a'),
      redirectRes('/b'),
      redirectRes('/c'),
      redirectRes('/d'),
    ]);
    const tool = createWebFetchTool({ lookup: okLookup, fetchImpl: fetch });
    const res = await tool.run({ url: 'https://public.example/start' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/too many redirects/);
  });

  it('非 http(s) 协议 → 拒绝', async () => {
    const tool = createWebFetchTool({ lookup: okLookup, fetchImpl: recordingFetch([]).fetch });
    const res = await tool.run({ url: 'ftp://example.com/file' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/only http\(s\)/);
  });

  it('HTML 响应去标签为文本', async () => {
    const { fetch } = recordingFetch([
      textRes('<html><body><h1>Docs</h1><p>Use <b>this</b> API.</p></body></html>', 'text/html'),
    ]);
    const tool = createWebFetchTool({ lookup: okLookup, fetchImpl: fetch });
    const res = await tool.run({ url: 'https://example.com/docs' }, makeCtx('/tmp'));
    expect(res.ok).toBe(true);
    expect(res.content).toContain('Docs');
    expect(res.content).toContain('Use this API.');
    expect(res.content).not.toMatch(/<[^>]*>/);
  });

  it('非 2xx → ok=false 且带状态码', async () => {
    const { fetch } = recordingFetch([
      new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } }),
    ]);
    const tool = createWebFetchTool({ lookup: okLookup, fetchImpl: fetch });
    const res = await tool.run({ url: 'https://example.com/missing' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/HTTP 404/);
  });

  it('响应体超过 50KB → 截断并提示', async () => {
    const { fetch } = recordingFetch([textRes('x'.repeat(60 * 1024))]);
    const tool = createWebFetchTool({ lookup: okLookup, fetchImpl: fetch });
    const res = await tool.run({ url: 'https://example.com/big' }, makeCtx('/tmp'));
    expect(res.ok).toBe(true);
    expect(res.content.endsWith('[content truncated at 50KB]')).toBe(true);
    expect(res.content.length).toBeLessThan(52 * 1024);
  });

  it('DNS 失败 / 网络失败 → ok=false 且不抛出', async () => {
    const tool1 = createWebFetchTool({
      lookup: () => Promise.reject(new Error('dns exploded')),
      fetchImpl: recordingFetch([]).fetch,
    });
    const res1 = await tool1.run({ url: 'https://no.example.com/' }, makeCtx('/tmp'));
    expect(res1.ok).toBe(false);
    expect(res1.content).toMatch(/dns exploded/);

    const tool2 = createWebFetchTool({
      lookup: okLookup,
      fetchImpl: () => Promise.reject(new TypeError('fetch failed: network down')),
    });
    const res2 = await tool2.run({ url: 'https://example.com/' }, makeCtx('/tmp'));
    expect(res2.ok).toBe(false);
    expect(res2.content).toMatch(/network down/);
  });
});

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

describe('web_search', () => {
  it('未配置 → 明确的配置指引', async () => {
    const tool = createWebSearchTool(undefined, { env: {}, fetchImpl: recordingFetch([]).fetch });
    const res = await tool.run({ query: 'node 24 release notes' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/web_search is not configured/);
    expect(res.content).toMatch(/config\.json/);
  });

  it('配置了 provider 但环境变量缺 key → 提示具体变量名', async () => {
    const tool = createWebSearchTool(
      { provider: 'tavily' },
      { env: {}, fetchImpl: recordingFetch([]).fetch },
    );
    const res = await tool.run({ query: 'x' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/TAVILY_API_KEY/);
  });

  it('tavily：Bearer 鉴权、max_results 默认 5、归一化输出', async () => {
    const { fetch, calls } = recordingFetch([
      new Response(
        JSON.stringify({
          results: [
            { title: 'Node 24', url: 'https://nodejs.org/en/blog', content: 'Release notes for Node 24.' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ]);
    const tool = createWebSearchTool(
      { provider: 'tavily' },
      { env: { TAVILY_API_KEY: 'tvly-test' }, fetchImpl: fetch },
    );
    const res = await tool.run({ query: 'node 24 release notes' }, makeCtx('/tmp'));

    expect(res.ok).toBe(true);
    expect(res.content).toContain('1. Node 24');
    expect(res.content).toContain('https://nodejs.org/en/blog');
    expect(res.content).toContain('Release notes for Node 24.');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.tavily.com/search');
    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tvly-test');
    // 测试里 body 恒为 JSON.stringify 的字符串
    expect(JSON.parse(init?.body as string)).toEqual({
      query: 'node 24 release notes',
      max_results: 5,
    });
  });

  it('bocha：嵌套 data.webPages.value 归一化', async () => {
    const { fetch, calls } = recordingFetch([
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            webPages: {
              value: [{ name: '博查结果', url: 'https://bochaai.com', snippet: '中文搜索片段' }],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ]);
    const tool = createWebSearchTool(
      { provider: 'bocha' },
      { env: { BOCHA_API_KEY: 'sk-b' }, fetchImpl: fetch },
    );
    const res = await tool.run({ query: '智能体', maxResults: 3 }, makeCtx('/tmp'));

    expect(res.ok).toBe(true);
    expect(res.content).toContain('博查结果');
    expect(res.content).toContain('中文搜索片段');
    expect(calls[0]?.url).toBe('https://api.bochaai.com/v1/web-search');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ query: '智能体', count: 3 });
  });

  it('serper：X-API-KEY 头与 num 参数', async () => {
    const { fetch, calls } = recordingFetch([
      new Response(
        JSON.stringify({
          organic: [{ title: 'Result', link: 'https://r.dev', snippet: 'snip' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ]);
    const tool = createWebSearchTool(
      { provider: 'serper', apiKeyEnv: 'MY_SERPER_KEY' },
      { env: { MY_SERPER_KEY: 'ser-1' }, fetchImpl: fetch },
    );
    const res = await tool.run({ query: 'q' }, makeCtx('/tmp'));

    expect(res.ok).toBe(true);
    expect(res.content).toContain('https://r.dev');
    expect(calls[0]?.url).toBe('https://google.serper.dev/search');
    expect(new Headers(calls[0]?.init?.headers).get('x-api-key')).toBe('ser-1');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ q: 'q', num: 5 });
  });

  it('provider HTTP 错误 → ok=false 带状态与响应片段', async () => {
    const { fetch } = recordingFetch([
      new Response('payment required', {
        status: 402,
        headers: { 'content-type': 'text/plain' },
      }),
    ]);
    const tool = createWebSearchTool(
      { provider: 'tavily' },
      { env: { TAVILY_API_KEY: 'k' }, fetchImpl: fetch },
    );
    const res = await tool.run({ query: 'x' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/tavily HTTP 402/);
    expect(res.content).toContain('payment required');
  });

  it('响应形状异常 → 明确报错', async () => {
    const { fetch } = recordingFetch([
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const tool = createWebSearchTool(
      { provider: 'tavily' },
      { env: { TAVILY_API_KEY: 'k' }, fetchImpl: fetch },
    );
    const res = await tool.run({ query: 'x' }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/unexpected tavily response shape/);
  });

  it('空结果集 → ok=true 提示无结果', async () => {
    const { fetch } = recordingFetch([
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    const tool = createWebSearchTool(
      { provider: 'tavily' },
      { env: { TAVILY_API_KEY: 'k' }, fetchImpl: fetch },
    );
    const res = await tool.run({ query: 'zzz nothing' }, makeCtx('/tmp'));
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/no results found/);
  });

  it('maxResults 超过 10 → zod 拒绝', async () => {
    const tool = createWebSearchTool(
      { provider: 'tavily' } satisfies WebSearchSettings,
      { env: { TAVILY_API_KEY: 'k' }, fetchImpl: recordingFetch([]).fetch },
    );
    const res = await tool.run({ query: 'x', maxResults: 11 }, makeCtx('/tmp'));
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/invalid arguments for web_search/);
  });
});
