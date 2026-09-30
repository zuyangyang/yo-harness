/**
 * 模型配置 store 单元测试：加载、保存 provider、切换当前模型、错误处理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelConfigView } from '../../src/api/client.js';
import { useModelStore } from '../../src/stores/model.js';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function stubFetch(...responses: Response[]): void {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
}

const VIEW: ModelConfigView = {
  source: 'web',
  active: { providerId: 'wlyd', model: 'deepseek-v4-pro' },
  providers: [
    {
      id: 'wlyd',
      displayName: 'wlyd',
      kind: 'openai-compat',
      baseURL: 'https://gateway.test/v1',
      hasKey: true,
      apiKeyHint: 'sk-…efgh',
      models: [{ id: 'deepseek-v4-pro' }],
      sortOrder: 0,
    },
  ],
  warnings: [],
  models: [],
  roles: [],
};

beforeEach(() => {
  useModelStore.setState({
    providers: [],
    active: { providerId: '', model: '' },
    source: 'default',
    warnings: [],
    isLoading: false,
    error: null,
  });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useModelStore', () => {
  it('load 填充 providers / active / source', async () => {
    stubFetch(response(VIEW));

    await useModelStore.getState().load();

    const state = useModelStore.getState();
    expect(state.providers).toHaveLength(1);
    expect(state.providers[0]?.id).toBe('wlyd');
    expect(state.active).toEqual({ providerId: 'wlyd', model: 'deepseek-v4-pro' });
    expect(state.source).toBe('web');
    expect(state.isLoading).toBe(false);
  });

  it('load 失败写入 error 且不抛异常', async () => {
    stubFetch(response({ error: 'boom' }, 500));

    await useModelStore.getState().load();

    expect(useModelStore.getState().error).toBeTruthy();
    expect(useModelStore.getState().isLoading).toBe(false);
  });

  it('saveProvider 保存后以服务端视图回填', async () => {
    stubFetch(
      response({ provider: VIEW.providers[0] }),
      response(VIEW),
    );

    await useModelStore.getState().saveProvider('wlyd', {
      kind: 'openai-compat',
      baseURL: 'https://gateway.test/v1',
      apiKey: 'sk-abcdefgh',
    });

    const state = useModelStore.getState();
    expect(state.providers.map((p) => p.id)).toEqual(['wlyd']);
    expect(state.active).toEqual({ providerId: 'wlyd', model: 'deepseek-v4-pro' });
    expect(JSON.stringify(state)).not.toContain('sk-abcdefgh');
  });

  it('saveActive 成功后 source 变为 web', async () => {
    stubFetch(response({ ok: true, active: { providerId: 'wlyd', model: 'deepseek-v4-pro' } }));

    await useModelStore.getState().saveActive({ providerId: 'wlyd', model: 'deepseek-v4-pro' });

    expect(useModelStore.getState().source).toBe('web');
    expect(useModelStore.getState().active).toEqual({ providerId: 'wlyd', model: 'deepseek-v4-pro' });
  });

  it('deleteProvider 移除本地项并重新加载', async () => {
    useModelStore.setState({ providers: VIEW.providers, active: VIEW.active, source: 'web' });
    stubFetch(
      response({ ok: true }),
      response({ ...VIEW, source: 'default', providers: [], active: { providerId: 'anthropic', model: 'claude-sonnet-4-5' } }),
    );

    await useModelStore.getState().deleteProvider('wlyd');

    const state = useModelStore.getState();
    expect(state.providers).toHaveLength(0);
    expect(state.source).toBe('default');
  });

  it('discover 返回模型列表', async () => {
    stubFetch(response({ models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }));

    const models = await useModelStore.getState().discover({ providerId: 'wlyd' });

    expect(models).toEqual([{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }]);
  });
});
