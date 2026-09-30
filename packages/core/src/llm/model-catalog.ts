/**
 * 模型目录端口（设计文档 docs/MODEL-CONFIG-DESIGN.md §7）。
 *
 * Web UI 的「获取可用模型」由 server 代发请求，避免浏览器 CORS 与密钥外泄。
 * 独立于 LLMClient 契约：只解决「这家 provider 有哪些模型」，
 * 不参与对话调用，便于测试注入 fetch。
 */
import { FatalError, TransientError, ValidationError } from '../types/errors.js';
import type { ModelDescriptor, ProviderKind } from '../types/model-config.js';

export interface ModelCatalogPort {
  listModels(): Promise<ModelDescriptor[]>;
}

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

function joinURL(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

async function requestJSON(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new TransientError(`${label}: request failed: ${String(err)}`);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const snippet = text.slice(0, 200).trim();
    throw new ValidationError(`${label}: HTTP ${res.status}${snippet.length > 0 ? ` — ${snippet}` : ''}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FatalError(`${label}: response is not valid JSON`);
  }
}

/** 兼容 OpenAI「{ data: [{ id }] }」与 Anthropic「{ data: [{ id, display_name }] }」 */
function parseModelList(payload: unknown, label: string): ModelDescriptor[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new FatalError(`${label}: unexpected response shape (not an object)`);
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new FatalError(`${label}: unexpected response shape (missing data array)`);
  }

  const models: ModelDescriptor[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string' || id.trim().length === 0) continue;
    models.push({ id: id.trim() });
  }
  return models;
}

export function createOpenAICompatCatalog(opts: {
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ModelCatalogPort {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const label = 'openai-compat list models';

  return {
    async listModels(): Promise<ModelDescriptor[]> {
      const headers: Record<string, string> = {};
      if (opts.apiKey !== undefined && opts.apiKey !== '') headers.Authorization = `Bearer ${opts.apiKey}`;
      const payload = await requestJSON(joinURL(opts.baseURL, '/models'), { method: 'GET', headers }, fetchImpl, timeoutMs, label);
      return parseModelList(payload, label);
    },
  };
}

export function createAnthropicCatalog(opts: {
  apiKey: string;
  baseURL?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ModelCatalogPort {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const label = 'anthropic list models';
  const baseURL = opts.baseURL ?? 'https://api.anthropic.com';

  return {
    async listModels(): Promise<ModelDescriptor[]> {
      const payload = await requestJSON(
        joinURL(baseURL, '/v1/models'),
        { method: 'GET', headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' } },
        fetchImpl,
        timeoutMs,
        label,
      );
      return parseModelList(payload, label);
    },
  };
}

/** 按 ProviderKind 选择实现（供 server 的 discovery 接口使用） */
export function createModelCatalog(input: {
  kind: ProviderKind;
  baseURL: string | undefined;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ModelCatalogPort {
  const shared = {
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };

  if (input.kind === 'anthropic') {
    if (input.apiKey === undefined || input.apiKey === '') {
      throw new ValidationError('anthropic: 缺少 API 密钥，无法获取模型列表');
    }
    return createAnthropicCatalog({
      apiKey: input.apiKey,
      ...(input.baseURL !== undefined ? { baseURL: input.baseURL } : {}),
      ...shared,
    });
  }

  if (input.baseURL === undefined || input.baseURL === '') {
    throw new ValidationError('openai-compat: 缺少 API 地址，无法获取模型列表');
  }
  return createOpenAICompatCatalog({
    baseURL: input.baseURL,
    ...(input.apiKey !== undefined && input.apiKey !== '' ? { apiKey: input.apiKey } : {}),
    ...shared,
  });
}
