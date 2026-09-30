import { describe, expect, it } from 'vitest';

import { apiKeyEnvName, kindForProviderId, resolveEffectiveModel } from '../../src/config/resolve-model.js';
import type { ProviderProfile } from '../../src/types/model-config.js';

const NO_ENV: Record<string, string | undefined> = {};

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'wlyd',
    displayName: 'wlyd',
    kind: 'openai-compat',
    baseURL: 'https://gpt-gateway-uat.wanmol.com/v1',
    hasKey: true,
    apiKeyHint: 'sk-…c0eA',
    models: [{ id: 'deepseek-v4-pro' }],
    sortOrder: 0,
    ...overrides,
  };
}

describe('resolveEffectiveModel', () => {
  it('无任何配置 → 内置默认 anthropic', () => {
    const result = resolveEffectiveModel({ resolveStoredKey: () => undefined, env: NO_ENV });

    expect(result.source).toBe('default');
    expect(result.providerId).toBe('anthropic');
    expect(result.kind).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(result.contextWindow).toBe(200_000);
    expect(result.apiKey).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('env 优先于内置默认（openai-compat 全字段）', () => {
    const result = resolveEffectiveModel({
      resolveStoredKey: () => undefined,
      env: {
        YO_PROVIDER: 'openai-compat',
        YO_MODEL: 'deepseek-v4-pro',
        YO_BASE_URL: 'https://gpt-gateway-uat.wanmol.com/v1',
        OPENAI_COMPAT_API_KEY: 'sk-env',
      },
    });

    expect(result.source).toBe('env');
    expect(result.kind).toBe('openai-compat');
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.baseURL).toBe('https://gpt-gateway-uat.wanmol.com/v1');
    expect(result.contextWindow).toBe(128_000);
    expect(result.apiKey).toBe('sk-env');
  });

  it('自定义 provider 名走 openai 兼容并映射 <NAME>_API_KEY', () => {
    const result = resolveEffectiveModel({
      resolveStoredKey: () => undefined,
      env: { YO_PROVIDER: 'wlyd', YO_MODEL: 'deepseek-flash', WLYD_API_KEY: 'sk-wlyd' },
    });

    expect(result.providerId).toBe('wlyd');
    expect(result.kind).toBe('openai-compat');
    expect(result.apiKey).toBe('sk-wlyd');
  });

  it('无 env 时用 config.json 默认值，source = file', () => {
    const result = resolveEffectiveModel({
      resolveStoredKey: () => undefined,
      env: NO_ENV,
      file: {
        defaultProvider: 'openai-compat',
        providers: { 'openai-compat': { model: 'deepseek-chat', baseURL: 'https://api.deepseek.com', contextWindow: 64_000 } },
      },
    });

    expect(result.source).toBe('file');
    expect(result.model).toBe('deepseek-chat');
    expect(result.baseURL).toBe('https://api.deepseek.com');
    expect(result.contextWindow).toBe(64_000);
  });

  it('Web UI 配置可用时优先于 env，source = web', () => {
    const result = resolveEffectiveModel({
      persisted: { selection: { providerId: 'wlyd', model: 'deepseek-v4-pro' }, profiles: [profile()] },
      resolveStoredKey: (id) => (id === 'wlyd' ? 'sk-stored' : undefined),
      env: { YO_PROVIDER: 'anthropic', YO_MODEL: 'claude-sonnet-4-5', ANTHROPIC_API_KEY: 'sk-ant' },
    });

    expect(result.source).toBe('web');
    expect(result.providerId).toBe('wlyd');
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.apiKey).toBe('sk-stored');
    expect(result.warnings).toEqual([]);
  });

  it('Web UI 模型自带 contextWindow 时优先使用', () => {
    const result = resolveEffectiveModel({
      persisted: {
        selection: { providerId: 'wlyd', model: 'deepseek-v4-pro' },
        profiles: [profile({ models: [{ id: 'deepseek-v4-pro', contextWindow: 256_000 }] })],
      },
      resolveStoredKey: () => 'sk-stored',
      env: NO_ENV,
    });

    expect(result.contextWindow).toBe(256_000);
  });

  it('Web UI provider 不存在 → 告警并回退 env', () => {
    const result = resolveEffectiveModel({
      persisted: { selection: { providerId: 'ghost', model: 'x' }, profiles: [profile()] },
      resolveStoredKey: () => 'sk-stored',
      env: { YO_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' },
    });

    expect(result.source).toBe('env');
    expect(result.providerId).toBe('anthropic');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('ghost');
  });

  it('Web UI 缺密钥 → 告警并回退', () => {
    const result = resolveEffectiveModel({
      persisted: { selection: { providerId: 'wlyd', model: 'deepseek-v4-pro' }, profiles: [profile()] },
      resolveStoredKey: () => undefined,
      env: { YO_PROVIDER: 'openai-compat', OPENAI_COMPAT_API_KEY: 'sk-env' },
    });

    expect(result.source).toBe('env');
    expect(result.providerId).toBe('openai-compat');
    expect(result.warnings[0]).toContain('缺少 API 密钥');
  });

  it('Web UI API 地址非法 → 告警并回退', () => {
    const result = resolveEffectiveModel({
      persisted: {
        selection: { providerId: 'wlyd', model: 'deepseek-v4-pro' },
        profiles: [profile({ baseURL: 'file:///etc/passwd' })],
      },
      resolveStoredKey: () => 'sk-stored',
      env: NO_ENV,
    });

    expect(result.source).toBe('default');
    expect(result.warnings[0]).toContain('API 地址非法');
  });
});

describe('helpers', () => {
  it('apiKeyEnvName 映射已知与自定义 provider', () => {
    expect(apiKeyEnvName('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(apiKeyEnvName('openai-compat')).toBe('OPENAI_COMPAT_API_KEY');
    expect(apiKeyEnvName('my-gateway')).toBe('MY_GATEWAY_API_KEY');
  });

  it('kindForProviderId 仅 anthropic 走原生协议', () => {
    expect(kindForProviderId('anthropic')).toBe('anthropic');
    expect(kindForProviderId('openai-compat')).toBe('openai-compat');
    expect(kindForProviderId('wlyd')).toBe('openai-compat');
  });
});
