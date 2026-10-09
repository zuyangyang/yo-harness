/**
 * 内置网络工具：web_fetch / web_search。
 *
 * web_fetch 的 SSRF 防护（本地 agent 直接暴露 URL 抓取时的红线）：
 * - 仅 http(s)；
 * - 每一跳（含重定向目标）先 DNS 解析，命中私网/环回段直接拒绝
 *   （127/8、10/8、172.16/12、192.168/16、169.254/16、0/8、::1、::、
 *   fe80::/10、fc00::/7，IPv4-mapped IPv6 归一化后同查）；
 * - 无法识别的地址一律按私网处理（保守）。
 * 重定向手动跟随（≤3 跳）以便逐跳复检；响应 50KB 截断；HTML 去标签。
 *
 * web_search 走配置的搜索 API（tavily / bocha / serper），未配置时
 * 返回明确的配置指引而不是抛错。密钥只从环境变量读取。
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';

import { formatToolError, ValidationError } from '../types/errors.js';
import type { Tool } from '../types/tools.js';
import { errorMessage } from '../utils/errors.js';

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 50 * 1024;
const MAX_REDIRECTS = 3;
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_DEFAULT_MAX_RESULTS = 5;

// ─── §10.2 结果缓存：进程级，带 TTL（同 turn / 短会话内重复请求只打一次） ───
const WEB_CACHE_TTL_MS = 5 * 60 * 1000;

interface WebCacheEntry {
  content: string;
  data: Record<string, unknown> | undefined;
  ts: number;
}

const webCache = new Map<string, WebCacheEntry>();

function cacheGet(key: string): WebCacheEntry | undefined {
  const entry = webCache.get(key);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.ts > WEB_CACHE_TTL_MS) {
    webCache.delete(key);
    return undefined;
  }
  return entry;
}

function cacheSet(key: string, content: string, data?: unknown): void {
  const record = typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
  webCache.set(key, { content, data: record, ts: Date.now() });
}

/** 仅供测试：清空缓存 */
export function clearWebCache(): void {
  webCache.clear();
}

export const WebFetchArgsSchema = z.object({
  url: z.string().url(),
});
export const WebSearchArgsSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(10).optional(),
});

// ---------------------------------------------------------------------------
// 地址判定
// ---------------------------------------------------------------------------

/** 是否私网/环回/链路本地等不可外访地址；无法识别时保守返回 true */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return true;
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b)) {
    return true;
  }
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateV6(ip: string): boolean {
  const norm = ip.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(norm);
  if (mapped?.[1] !== undefined) return isPrivateV4(mapped[1]);
  return (
    norm === '::1' ||
    norm === '::' ||
    norm.startsWith('fe8') ||
    norm.startsWith('fe9') ||
    norm.startsWith('fea') ||
    norm.startsWith('feb') || // fe80::/10 链路本地
    norm.startsWith('fc') ||
    norm.startsWith('fd') // fc00::/7 ULA
  );
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`web_fetch: invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(
      `web_fetch: only http(s) URLs are supported, got "${url.protocol}"`,
    );
  }
  return url;
}

async function assertPublicAddress(
  hostname: string,
  lookup: (hostname: string) => Promise<string[]>,
): Promise<void> {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new ValidationError(`web_fetch blocked: ${host} is a private/loopback address`);
    }
    return;
  }
  const addrs = await lookup(host);
  const privateAddr = addrs.find((addr) => isPrivateAddress(addr));
  if (addrs.length === 0 || privateAddr !== undefined) {
    throw new ValidationError(
      `web_fetch blocked: ${hostname} resolves to ${privateAddr ?? 'no addresses'} — private/loopback targets are not allowed`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTML → 纯文本（无第三方依赖的近似实现）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function htmlToText(html: string): string {
  const noTags = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(noTags)
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body.startsWith('#x') || body.startsWith('#X');
        const code = isHex
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? match;
    },
  );
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export interface WebFetchDeps {
  /** DNS 解析（默认 node:dns/promises），测试注入用 */
  lookup?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
}

const defaultLookup = async (hostname: string): Promise<string[]> => {
  const result = await dnsLookup(hostname, { all: true });
  return result.map((r) => r.address);
};

async function readBodyCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (res.body === null) return { text: '', truncated: false };
  // undici-types 将 ReadableStream 的泛型标为 any；这里显式收窄一次，后续全程有类型。
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    if (total + value.byteLength > FETCH_MAX_BYTES) {
      const keep = FETCH_MAX_BYTES - total;
      if (keep > 0) chunks.push(value.subarray(0, keep));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  let text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  if (text.endsWith('�')) text = text.slice(0, -1); // 截断切在多字节字符中间
  return { text, truncated };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function createWebFetchTool(deps: WebFetchDeps = {}): Tool {
  const lookup = deps.lookup ?? defaultLookup;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return {
    name: 'web_fetch',
    description: [
      'Fetch an http(s) URL and return readable text.',
      'Use after web_search to read a promising result, or for any public documentation page.',
      'Only http(s) is allowed; private/loopback addresses are blocked (SSRF protection); redirects are followed up to 3 hops with each target re-checked;',
      'responses are capped at 50KB and HTML is stripped to plain text.',
      'Fails on non-2xx status, timeouts (15s), or blocked addresses.',
    ].join(' '),
    risk: 'net',
    inputSchema: WebFetchArgsSchema,
    async run(raw) {
      const parsed = WebFetchArgsSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          content: `invalid arguments for web_fetch: ${z.prettifyError(parsed.error)}`,
        };
      }
      const cacheKey = `web_fetch:${parsed.data.url}`;
      const cached = cacheGet(cacheKey);
      if (cached !== undefined) {
        return { ok: true, content: cached.content, data: { ...(cached.data ?? {}), cached: true } };
      }
      try {
        let current = parseHttpUrl(parsed.data.url);
        for (let hop = 0; ; hop++) {
          await assertPublicAddress(current.hostname, lookup);
          const res = await fetchImpl(current, {
            redirect: 'manual',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'user-agent': 'yo-harness/0.1' },
          });
          if (isRedirectStatus(res.status)) {
            if (hop >= MAX_REDIRECTS) {
              return { ok: false, content: `web_fetch: too many redirects (>${MAX_REDIRECTS})` };
            }
            const location = res.headers.get('location');
            if (location === null) {
              return {
                ok: false,
                content: `web_fetch: redirect without Location header (HTTP ${res.status})`,
              };
            }
            current = parseHttpUrl(new URL(location, current).toString());
            continue;
          }
          const { text, truncated } = await readBodyCapped(res);
          if (!res.ok) {
            const detail = text === '' ? '' : `\n${text.slice(0, 500)}`;
            return { ok: false, content: `web_fetch: HTTP ${res.status} ${res.statusText}${detail}` };
          }
          const isHtml = (res.headers.get('content-type') ?? '')
            .toLowerCase()
            .includes('text/html');
          let content = isHtml ? htmlToText(text) : text;
          if (truncated) content += '\n[content truncated at 50KB]';
          const resultData = { url: current.toString(), status: res.status };
          cacheSet(cacheKey, content, resultData);
          return {
            ok: true,
            content,
            data: resultData,
          };
        }
      } catch (err) {
        if (err instanceof ValidationError) {
          return { ok: false, content: err.message };
        }
        // 网络错误（超时、连接失败等）视为瞬态错误，可重试
        const msg = errorMessage(err);
        const isNetworkError =
          msg.includes('ETIMEDOUT') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ECONNRESET') ||
          msg.includes('ENOTFOUND') ||
          msg.includes('timeout') ||
          msg.includes('network');
        if (isNetworkError) {
          return {
            ok: false,
            errorKind: 'transient',
            content: formatToolError({
              kind: 'transient',
              message: `web_fetch network error: ${msg}`,
              suggestion: 'This is likely a temporary network issue. The system will retry automatically.',
            }),
          };
        }
        return { ok: false, content: `web_fetch failed: ${msg}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

export type SearchProviderName = 'tavily' | 'bocha' | 'serper';

export interface WebSearchSettings {
  provider: SearchProviderName;
  /** 存放 API key 的环境变量名；缺省取 provider 默认名 */
  apiKeyEnv?: string;
}

export interface WebSearchDeps {
  fetchImpl?: typeof fetch;
  /** 默认 process.env，测试注入用 */
  env?: Record<string, string | undefined>;
}

const DEFAULT_KEY_ENV: Record<SearchProviderName, string> = {
  tavily: 'TAVILY_API_KEY',
  bocha: 'BOCHA_API_KEY',
  serper: 'SERPER_API_KEY',
};

interface NormalizedResult {
  title: string;
  url: string;
  snippet: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 三家 provider 的响应形状归一化（tavily: results / serper: organic / bocha: data.webPages.value） */
function normalizeResults(provider: string, json: unknown): NormalizedResult[] {
  const root = asRecord(json);
  let items: unknown;
  if (Array.isArray(root.results)) items = root.results;
  else if (Array.isArray(root.organic)) items = root.organic;
  else {
    const webPages = asRecord(asRecord(root.data).webPages);
    items = webPages.value;
  }
  if (!Array.isArray(items)) {
    throw new Error(`unexpected ${provider} response shape (no results array)`);
  }
  const out: NormalizedResult[] = [];
  for (const item of items) {
    const rec = asRecord(item);
    const title = asString(rec.title ?? rec.name);
    const url = asString(rec.url ?? rec.link);
    const snippet = asString(rec.content ?? rec.snippet ?? rec.summary);
    if (title !== '' || url !== '' || snippet !== '') {
      out.push({ title, url, snippet });
    }
  }
  return out;
}

async function ensureOk(res: Response, provider: string): Promise<void> {
  if (res.ok) return;
  const body = (await res.text()).slice(0, 300);
  throw new Error(`${provider} HTTP ${res.status}: ${body}`);
}

async function tavilySearch(
  query: string,
  maxResults: number,
  key: string,
  fetchImpl: typeof fetch,
): Promise<NormalizedResult[]> {
  const res = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: maxResults }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  await ensureOk(res, 'tavily');
  const json: unknown = await res.json();
  return normalizeResults('tavily', json);
}

async function bochaSearch(
  query: string,
  maxResults: number,
  key: string,
  fetchImpl: typeof fetch,
): Promise<NormalizedResult[]> {
  const res = await fetchImpl('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, count: maxResults }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  await ensureOk(res, 'bocha');
  const json: unknown = await res.json();
  return normalizeResults('bocha', json);
}

async function serperSearch(
  query: string,
  maxResults: number,
  key: string,
  fetchImpl: typeof fetch,
): Promise<NormalizedResult[]> {
  const res = await fetchImpl('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ q: query, num: maxResults }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  await ensureOk(res, 'serper');
  const json: unknown = await res.json();
  return normalizeResults('serper', json);
}

export function createWebSearchTool(
  settings: WebSearchSettings | undefined,
  deps: WebSearchDeps = {},
): Tool {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const env = deps.env ?? process.env;

  return {
    name: 'web_search',
    description: [
      'Search the web with the configured search API (tavily / bocha / serper).',
      'Use for facts, current events, documentation, and anything not already in the workspace.',
      '`query` is a short keyword query (not a natural-language question); `maxResults` (1-10, default 5) bounds the answer.',
      'Returns a numbered list of title, URL, and snippet.',
      'Fails with configuration guidance when no search provider is configured or the API key is missing.',
    ].join(' '),
    risk: 'net',
    inputSchema: WebSearchArgsSchema,
    async run(raw) {
      const parsed = WebSearchArgsSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          content: `invalid arguments for web_search: ${z.prettifyError(parsed.error)}`,
        };
      }
      const maxResults = parsed.data.maxResults ?? SEARCH_DEFAULT_MAX_RESULTS;

      if (settings === undefined) {
        return {
          ok: false,
          content:
            'web_search is not configured. Add {"search": {"provider": "tavily" | "bocha" | "serper", "apiKeyEnv": "TAVILY_API_KEY"}} to ~/.yo-harness/config.json and export the key. See .env.example.',
        };
      }
      const keyEnvName = settings.apiKeyEnv ?? DEFAULT_KEY_ENV[settings.provider];
      const key = env[keyEnvName];
      if (key === undefined || key === '') {
        return {
          ok: false,
          content: `web_search: API key not found — set ${keyEnvName} in the environment.`,
        };
      }

      const cacheKey = `web_search:${settings.provider}:${parsed.data.query}:${maxResults}`;
      const cached = cacheGet(cacheKey);
      if (cached !== undefined) {
        return { ok: true, content: cached.content, data: { ...(cached.data ?? {}), cached: true } };
      }

      try {
        let results: NormalizedResult[];
        switch (settings.provider) {
          case 'tavily':
            results = await tavilySearch(parsed.data.query, maxResults, key, fetchImpl);
            break;
          case 'bocha':
            results = await bochaSearch(parsed.data.query, maxResults, key, fetchImpl);
            break;
          case 'serper':
            results = await serperSearch(parsed.data.query, maxResults, key, fetchImpl);
            break;
        }
        if (results.length === 0) {
          return { ok: true, content: `no results found for "${parsed.data.query}"` };
        }
        const content = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join('\n\n');
        const resultData = { count: results.length };
        cacheSet(cacheKey, content, resultData);
        return { ok: true, content, data: resultData };
      } catch (err) {
        const msg = errorMessage(err);
        // 网络错误视为瞬态错误，可重试
        const isNetworkError =
          msg.includes('ETIMEDOUT') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ECONNRESET') ||
          msg.includes('ENOTFOUND') ||
          msg.includes('timeout') ||
          msg.includes('network') ||
          msg.includes('fetch failed');
        if (isNetworkError) {
          return {
            ok: false,
            errorKind: 'transient',
            content: formatToolError({
              kind: 'transient',
              message: `web_search network error: ${msg}`,
              suggestion: 'This is likely a temporary network issue. The system will retry automatically.',
            }),
          };
        }
        return { ok: false, content: `web_search failed: ${msg}` };
      }
    },
  };
}
