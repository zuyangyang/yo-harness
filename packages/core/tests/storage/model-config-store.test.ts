import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/storage/db.js';
import { SqliteModelConfigStore } from '../../src/storage/model-config-store.js';
import type { ProviderRecordInput } from '../../src/types/model-config.js';

let db: SqliteDatabase;
let store: SqliteModelConfigStore;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = new SqliteModelConfigStore(db);
});

function input(overrides: Partial<ProviderRecordInput> = {}): ProviderRecordInput {
  return {
    id: 'wlyd',
    displayName: 'wlyd',
    kind: 'openai-compat',
    baseURL: 'https://gpt-gateway-uat.wanmol.com/v1',
    apiKeyCipher: 'v1:aaa:bbb:ccc',
    apiKeyHint: 'sk-…c0eA',
    apiKeyEnv: undefined,
    models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro', contextWindow: 256_000 }],
    defaultContextWindow: 128_000,
    sortOrder: 0,
    ...overrides,
  };
}

describe('SqliteModelConfigStore', () => {
  it('upsert 新 provider 后可读回全部字段', async () => {
    const saved = await store.upsertProvider(input());

    expect(saved.id).toBe('wlyd');
    expect(saved.displayName).toBe('wlyd');
    expect(saved.kind).toBe('openai-compat');
    expect(saved.baseURL).toBe('https://gpt-gateway-uat.wanmol.com/v1');
    expect(saved.apiKeyCipher).toBe('v1:aaa:bbb:ccc');
    expect(saved.apiKeyHint).toBe('sk-…c0eA');
    expect(saved.apiKeyEnv).toBeUndefined();
    expect(saved.defaultContextWindow).toBe(128_000);
    expect(saved.createdAt).toBeTruthy();
    expect(saved.models).toEqual([{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro', contextWindow: 256_000 }]);

    await expect(store.getProvider('wlyd')).resolves.toEqual(saved);
  });

  it('upsert 已存在 provider 保留 createdAt 并覆盖字段', async () => {
    const first = await store.upsertProvider(input());
    const second = await store.upsertProvider(input({ displayName: 'wlyd-2', models: [{ id: 'm1' }], apiKeyCipher: undefined }));

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.displayName).toBe('wlyd-2');
    expect(second.models).toEqual([{ id: 'm1' }]);
    expect(second.apiKeyCipher).toBeUndefined();
    await expect(store.listProviders()).resolves.toHaveLength(1);
  });

  it('listProviders 按 sort_order 排序', async () => {
    await store.upsertProvider(input({ id: 'b', sortOrder: 5 }));
    await store.upsertProvider(input({ id: 'a', sortOrder: 1 }));
    await store.upsertProvider(input({ id: 'c', sortOrder: 9 }));

    const ids = (await store.listProviders()).map((p) => p.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('models_json 损坏时降级为空目录而不是抛错', async () => {
    db.prepare(
      `INSERT INTO model_providers
         (id, display_name, kind, base_url, api_key_cipher, api_key_hint, api_key_env,
          models_json, default_context_window, sort_order, created_at, updated_at)
       VALUES ('bad', 'bad', 'openai-compat', NULL, NULL, NULL, NULL, 'not-json', NULL, 0, 'now', 'now')`,
    ).run();

    const record = await store.getProvider('bad');
    expect(record?.models).toEqual([]);
  });

  it('deleteProvider 移除记录', async () => {
    await store.upsertProvider(input());
    await store.deleteProvider('wlyd');
    await expect(store.getProvider('wlyd')).resolves.toBeUndefined();
  });

  it('settings 初始未配置，保存后可读回，clear 后清空', async () => {
    await expect(store.getSettings()).resolves.toBeUndefined();

    await store.saveSettings({ providerId: 'wlyd', model: 'deepseek-v4-pro' });
    await expect(store.getSettings()).resolves.toEqual({ providerId: 'wlyd', model: 'deepseek-v4-pro' });

    await store.saveSettings({ providerId: 'deepseek', model: 'deepseek-chat' });
    await expect(store.getSettings()).resolves.toEqual({ providerId: 'deepseek', model: 'deepseek-chat' });

    await store.clearSettings();
    await expect(store.getSettings()).resolves.toBeUndefined();
  });
});
