import { describe, expect, it, vi } from 'vitest';

import type { ModelConfigStore } from '@yo-harness/core/core/ports.js';
import type {
  ModelDescriptor,
  ModelSelection,
  ProviderRecord,
  ProviderRecordInput,
} from '@yo-harness/core/types/model-config.js';
import { ValidationError } from '@yo-harness/core/types/errors.js';

import { ModelConfigService } from '../src/model-config-service.js';
import { SecretCrypto } from '../src/secret-crypto.js';

const HEX_KEY = 'a'.repeat(64);
const CRYPTO = new SecretCrypto(HEX_KEY);

class MemoryStore implements ModelConfigStore {
  private readonly providers = new Map<string, ProviderRecord>();
  private settings: ModelSelection | undefined;

  async listProviders(): Promise<ProviderRecord[]> {
    return [...this.providers.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async getProvider(id: string): Promise<ProviderRecord | undefined> {
    return this.providers.get(id);
  }

  async upsertProvider(input: ProviderRecordInput): Promise<ProviderRecord> {
    const existing = this.providers.get(input.id);
    const now = new Date().toISOString();
    const record: ProviderRecord = { ...input, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.providers.set(input.id, record);
    return record;
  }

  async deleteProvider(id: string): Promise<void> {
    this.providers.delete(id);
  }

  async getSettings(): Promise<ModelSelection | undefined> {
    return this.settings;
  }

  async saveSettings(selection: ModelSelection): Promise<void> {
    this.settings = selection;
  }

  async clearSettings(): Promise<void> {
    this.settings = undefined;
  }
}

function makeService(options: { store?: ModelConfigStore; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; onChange?: () => void } = {}) {
  const store = options.store ?? new MemoryStore();
  const service = new ModelConfigService({
    store,
    env: options.env ?? {},
    crypto: CRYPTO,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onChange !== undefined ? { onChange: options.onChange } : {}),
  });
  return { store, service };
}

const CATALOG: ModelDescriptor[] = [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro', contextWindow: 256_000 }];

describe('ModelConfigService.resolve', () => {
  it('无 Web UI 配置时回退到 env', async () => {
    const { service } = makeService({ env: { YO_PROVIDER: 'openai-compat', YO_MODEL: 'deepseek-chat', OPENAI_COMPAT_API_KEY: 'sk-env' } });
    const effective = await service.resolve();

    expect(effective.source).toBe('env');
    expect(effective.providerId).toBe('openai-compat');
    expect(effective.model).toBe('deepseek-chat');
    expect(effective.apiKey).toBe('sk-env');
  });

  it('Web UI 配置可用时优先于 env', async () => {
    const { store, service } = makeService({ env: { YO_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' } });
    await service.saveProvider({ id: 'wlyd', kind: 'openai-compat', baseURL: 'https://gateway.test/v1', apiKey: 'sk-wlyd', models: CATALOG });
    await service.saveSelection({ providerId: 'wlyd', model: 'deepseek-v4-pro' });

    const effective = await service.resolve();
    expect(effective.source).toBe('web');
    expect(effective.providerId).toBe('wlyd');
    expect(effective.model).toBe('deepseek-v4-pro');
    expect(effective.apiKey).toBe('sk-wlyd');
    expect(effective.contextWindow).toBe(256_000);
    expect(await store.getSettings()).toEqual({ providerId: 'wlyd', model: 'deepseek-v4-pro' });
  });

  it('选中 provider 后密钥丢失 → 告警并回退 env', async () => {
    const store = new MemoryStore();
    // 直接写入无密钥的档案
    await store.upsertProvider({
      id: 'wlyd', displayName: 'wlyd', kind: 'openai-compat',
      baseURL: 'https://gateway.test/v1', apiKeyCipher: undefined, apiKeyHint: undefined,
      apiKeyEnv: undefined, models: CATALOG, defaultContextWindow: undefined, sortOrder: 0,
    });
    await store.saveSettings({ providerId: 'wlyd', model: 'deepseek-v4-pro' });

    const { service } = makeService({ store, env: { YO_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' } });
    const effective = await service.resolve();

    expect(effective.source).toBe('env');
    expect(effective.providerId).toBe('anthropic');
    expect(effective.warnings[0]).toContain('缺少 API 密钥');
  });
});

describe('ModelConfigService.saveProvider', () => {
  it('密钥加密落库、只回传掩码', async () => {
    const store = new MemoryStore();
    const { service } = makeService({ store });

    const profile = await service.saveProvider({
      id: 'wlyd', kind: 'openai-compat', baseURL: 'https://gateway.test/v1',
      apiKey: 'sk-super-secret-value', models: CATALOG,
    });

    const record = await store.getProvider('wlyd');
    expect(record?.apiKeyCipher).toBeDefined();
    expect(record?.apiKeyCipher).not.toContain('sk-super-secret-value');
    expect(profile.hasKey).toBe(true);
    expect(profile.apiKeyHint).toBe('sk-…alue');
    expect(JSON.stringify(profile)).not.toContain('sk-super-secret-value');
  });

  it('空 apiKey 保留已有密钥', async () => {
    const store = new MemoryStore();
    const { service } = makeService({ store });
    await service.saveProvider({ id: 'wlyd', kind: 'openai-compat', baseURL: 'https://gateway.test/v1', apiKey: 'sk-first' });
    const firstCipher = (await store.getProvider('wlyd'))?.apiKeyCipher;

    await service.saveProvider({ id: 'wlyd', kind: 'openai-compat', displayName: 'renamed', apiKey: '' });

    const record = await store.getProvider('wlyd');
    expect(record?.apiKeyCipher).toBe(firstCipher);
    expect(record?.displayName).toBe('renamed');
  });

  it('openai-compat 缺少 API 地址 → ValidationError', async () => {
    const { service } = makeService();
    await expect(service.saveProvider({ id: 'x', kind: 'openai-compat' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('保存后触发 onChange 重建运行时', async () => {
    const onChange = vi.fn();
    const { service } = makeService({ onChange });
    await service.saveProvider({ id: 'wlyd', kind: 'openai-compat', baseURL: 'https://gateway.test/v1', apiKey: 'sk-1' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('ModelConfigService 运行时', () => {
  it('无密钥 → isFake（不阻塞启动）', async () => {
    const { service } = makeService({ env: {} });
    const runtime = await service.buildRuntime();

    expect(runtime.isFake).toBe(true);
    expect(runtime.router.getClient('main').name).toBe('fake');
  });

  it('有密钥 → 真实 client，providerId 作为网关注册键', async () => {
    const { service } = makeService();
    await service.saveProvider({ id: 'wlyd', kind: 'openai-compat', baseURL: 'https://gateway.test/v1', apiKey: 'sk-1' });
    await service.saveSelection({ providerId: 'wlyd', model: 'deepseek-v4-pro' });

    const runtime = await service.getRuntime();
    expect(runtime.isFake).toBe(false);
    expect(runtime.providerId).toBe('wlyd');
    expect(runtime.router.getClient('main').name).toBe('wlyd');
  });
});

describe('ModelConfigService 会话级模型', () => {
  it('按 "providerId/modelId" 构建独立运行时（含模型自带 contextWindow）', async () => {
    const { service } = makeService();
    await service.saveProvider({
      id: 'wlyd-llm',
      kind: 'openai-compat',
      baseURL: 'https://gateway.test/v1',
      apiKey: 'sk-wlyd',
      models: [
        { id: 'deepseek-flash' },
        { id: 'deepseek-v4-pro', contextWindow: 256_000 },
      ],
    });
    await service.saveSelection({ providerId: 'wlyd-llm', model: 'deepseek-flash' });

    const runtime = await service.buildRuntimeForModel('wlyd-llm/deepseek-v4-pro');

    expect(runtime.providerId).toBe('wlyd-llm');
    expect(runtime.model).toBe('deepseek-v4-pro');
    expect(runtime.contextWindow).toBe(256_000);
    expect(runtime.isFake).toBe(false);
    expect(runtime.router.getClient('main').name).toBe('wlyd-llm');
  });

  it('标签无法解析 / provider 不存在 / 无密钥 → 回退全局默认运行时', async () => {
    const { service } = makeService({ env: { YO_PROVIDER: 'openai-compat', OPENAI_COMPAT_API_KEY: 'sk-env' } });
    await service.saveProvider({ id: 'nokey', kind: 'openai-compat', baseURL: 'https://gateway.test/v1' });

    const fallbackProviderId = (await service.getRuntime()).providerId;

    await expect(service.buildRuntimeForModel(undefined)).resolves.toMatchObject({ providerId: fallbackProviderId });
    await expect(service.buildRuntimeForModel('')).resolves.toMatchObject({ providerId: fallbackProviderId });
    await expect(service.buildRuntimeForModel('没有斜杠')).resolves.toMatchObject({ providerId: fallbackProviderId });
    await expect(service.buildRuntimeForModel('ghost/model')).resolves.toMatchObject({ providerId: fallbackProviderId });
    await expect(service.buildRuntimeForModel('nokey/model')).resolves.toMatchObject({ providerId: fallbackProviderId });
  });
});

describe('ModelConfigService.view', () => {
  it('回显 provider 列表、当前选择与来源', async () => {
    const { service } = makeService({ env: { YO_PROVIDER: 'openai-compat', OPENAI_COMPAT_API_KEY: 'sk-env' } });
    await service.saveProvider({ id: 'wlyd', kind: 'openai-compat', baseURL: 'https://gateway.test/v1', apiKey: 'sk-wlyd-abcdefgh', models: CATALOG });
    await service.saveSelection({ providerId: 'wlyd', model: 'deepseek-flash' });

    const view = await service.view();

    expect(view.source).toBe('web');
    expect(view.active).toEqual({ providerId: 'wlyd', model: 'deepseek-flash' });
    expect(view.providers).toHaveLength(1);
    expect(view.providers[0]?.apiKeyHint).toBe('sk-…efgh');
    expect(JSON.stringify(view)).not.toContain('sk-wlyd-abcdefgh');
  });

  it('无 Web UI 选择时 active 反映 env 解析结果', async () => {
    const { service } = makeService({ env: { YO_PROVIDER: 'openai-compat', YO_MODEL: 'deepseek-chat', OPENAI_COMPAT_API_KEY: 'k' } });
    const view = await service.view();
    expect(view.source).toBe('env');
    expect(view.active).toEqual({ providerId: 'openai-compat', model: 'deepseek-chat' });
  });
});

describe('ModelConfigService.deleteProvider / saveSelection', () => {
  it('删除 active provider 会清空选择', async () => {
    const store = new MemoryStore();
    const { service } = makeService({ store, env: { YO_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' } });
    await service.saveProvider({ id: 'wlyd', kind: 'openai-compat', baseURL: 'https://gateway.test/v1', apiKey: 'sk-1' });
    await service.saveSelection({ providerId: 'wlyd', model: 'deepseek-v4-pro' });

    await service.deleteProvider('wlyd');

    expect(await store.getSettings()).toBeUndefined();
    expect(await store.getProvider('wlyd')).toBeUndefined();
    expect((await service.resolve()).source).toBe('env');
  });

  it('选择不存在的 provider → ValidationError', async () => {
    const { service } = makeService();
    await expect(service.saveSelection({ providerId: 'ghost', model: 'm' })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('ModelConfigService.discover', () => {
  it('使用库存密钥与地址请求模型列表', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { service } = makeService({ fetchImpl });
    await service.saveProvider({ id: 'wlyd', kind: 'openai-compat', baseURL: 'https://gateway.test/v1', apiKey: 'sk-stored' });

    const models = await service.discover({ providerId: 'wlyd' });

    expect(models).toEqual([{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]);
    expect(calls[0]?.url).toBe('https://gateway.test/v1/models');
    expect(calls[0]?.headers.Authorization).toBe('Bearer sk-stored');
  });

  it('保存前可用临时凭据试连', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })) as unknown as typeof fetch;
    const { service } = makeService({ fetchImpl });

    const models = await service.discover({ kind: 'openai-compat', baseURL: 'https://tmp.test/v1', apiKey: 'sk-tmp' });
    expect(models).toEqual([{ id: 'm1' }]);
  });

  it('provider 不存在 → ValidationError', async () => {
    const { service } = makeService();
    await expect(service.discover({ providerId: 'ghost' })).rejects.toBeInstanceOf(ValidationError);
  });
});
