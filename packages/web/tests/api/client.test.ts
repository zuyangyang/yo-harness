/**
 * API client 单元测试：验证 fetch 封装、JWT 自动附加、错误处理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, clearToken, fetchJson, setToken, ApiError } from '../../src/api/client.js';

function mockFetchResponse(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

function lastFetchCall(): { url: string; init: RequestInit } | undefined {
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) return undefined;
  return { url: last[0] as string, init: last[1] as RequestInit };
}

describe('API client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    clearToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchJson', () => {
    it('GET 请求无 body', async () => {
      mockFetchResponse({ data: 'test' });
      const result = await fetchJson<{ data: string }>('GET', '/test');
      expect(result.data).toBe('test');

      const call = lastFetchCall();
      expect(call?.url).toBe('/test');
      expect(call?.init.method).toBe('GET');
      expect(call?.init.body).toBeUndefined();
    });

    it('POST 请求带 body', async () => {
      mockFetchResponse({});
      await fetchJson('POST', '/test', { foo: 'bar' });

      const call = lastFetchCall();
      expect(call?.init.method).toBe('POST');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ foo: 'bar' });
    });

    it('自动附加 Authorization header', async () => {
      setToken('mytoken');
      mockFetchResponse({});
      await fetchJson('GET', '/test');

      const call = lastFetchCall();
      const headers = call!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer mytoken');
    });

    it('无 token 时不附加 Authorization', async () => {
      mockFetchResponse({});
      await fetchJson('GET', '/test');

      const call = lastFetchCall();
      const headers = call!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('HTTP 错误抛 ApiError', async () => {
      mockFetchResponse({ error: 'not found' }, 404);
      await expect(fetchJson('GET', '/test')).rejects.toThrow(ApiError);
      try {
        await fetchJson('GET', '/test');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(404);
      }
    });
  });

  describe('api.auth', () => {
    it('login 发送正确请求', async () => {
      mockFetchResponse({
        accessToken: 'tok',
        refreshToken: 'ref',
        user: { id: 'u1', username: 'alice', role: 'member' },
      });

      await api.auth.login({ tenantId: 't1', username: 'alice', password: 'secret' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/auth/login');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ tenantId: 't1', username: 'alice', password: 'secret' });
    });

    it('register 发送正确请求', async () => {
      mockFetchResponse({
        accessToken: 'tok',
        refreshToken: 'ref',
        user: { id: 'u1', username: 'alice', role: 'member' },
      });

      await api.auth.register({ tenantId: 't1', username: 'alice', password: 'secret', email: 'alice@example.com' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/auth/register');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ tenantId: 't1', username: 'alice', password: 'secret', email: 'alice@example.com' });
    });
  });

  describe('api.sessions', () => {
    it('list 带 limit', async () => {
      mockFetchResponse({ sessions: [] });
      await api.sessions.list({ limit: 10 });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions?limit=10');
    });

    it('list 带 workspaceId=none 与 q', async () => {
      mockFetchResponse({ sessions: [] });
      await api.sessions.list({ workspaceId: null, q: '重构' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions?workspaceId=none&q=%E9%87%8D%E6%9E%84&limit=50');
    });

    it('create 发送 model/cwd', async () => {
      mockFetchResponse({ session: { id: 's1' } });
      await api.sessions.create({ model: 'gpt-4', cwd: '/tmp' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ model: 'gpt-4', cwd: '/tmp' });
    });

    it('update 发送 PATCH', async () => {
      mockFetchResponse({ session: { id: 's1' } });
      await api.sessions.update('s1', { title: '新名字', pinned: true });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions/s1');
      expect(call?.init.method).toBe('PATCH');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ title: '新名字', pinned: true });
    });

    it('sendMessage 发送 content', async () => {
      mockFetchResponse({});
      await api.sessions.sendMessage('s1', 'hello');

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions/s1/messages');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ content: 'hello' });
    });

    it('update 发送会话级 model', async () => {
      mockFetchResponse({ session: { id: 's1' } });
      await api.sessions.update('s1', { model: 'wlyd-llm/deepseek-v4-pro' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions/s1');
      expect(call?.init.method).toBe('PATCH');
      expect(JSON.parse(call!.init.body as string)).toEqual({ model: 'wlyd-llm/deepseek-v4-pro' });
    });
  });

  describe('api.workspaces', () => {
    it('create 发送 name', async () => {
      mockFetchResponse({ workspace: { id: 'w1' } });
      await api.workspaces.create({ name: '工作' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/workspaces');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ name: '工作' });
    });

    it('delete 带 purge', async () => {
      mockFetchResponse({ ok: true });
      await api.workspaces.delete('w1', true);

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/workspaces/w1?purge=true');
    });
  });

  describe('api.models', () => {
    it('list 返回 provider / active / source', async () => {
      mockFetchResponse({
        source: 'web',
        active: { providerId: 'wlyd', model: 'deepseek-v4-pro' },
        providers: [{ id: 'wlyd' }],
        warnings: [],
        models: [],
        roles: [],
      });
      const view = await api.models.list();

      expect(lastFetchCall()?.url).toBe('/api/v1/models');
      expect(view.source).toBe('web');
      expect(view.active.providerId).toBe('wlyd');
    });

    it('saveProvider 用 PUT 并转义 id', async () => {
      mockFetchResponse({ provider: { id: 'a b' } });
      await api.models.saveProvider('a b', { kind: 'openai-compat', baseURL: 'https://x.test/v1', apiKey: 'sk-1' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/models/providers/a%20b');
      expect(call?.init.method).toBe('PUT');
      expect(JSON.parse(call!.init.body as string)).toEqual({
        kind: 'openai-compat',
        baseURL: 'https://x.test/v1',
        apiKey: 'sk-1',
      });
    });

    it('deleteProvider 用 DELETE', async () => {
      mockFetchResponse({ ok: true });
      await api.models.deleteProvider('wlyd');

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/models/providers/wlyd');
      expect(call?.init.method).toBe('DELETE');
    });

    it('saveActive 提交当前选择', async () => {
      mockFetchResponse({ ok: true, active: { providerId: 'wlyd', model: 'm' } });
      await api.models.saveActive({ providerId: 'wlyd', model: 'm' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/models/active');
      expect(call?.init.method).toBe('PUT');
      expect(JSON.parse(call!.init.body as string)).toEqual({ providerId: 'wlyd', model: 'm' });
    });

    it('discover 用 POST 并返回模型列表', async () => {
      mockFetchResponse({ models: [{ id: 'deepseek-flash' }] });
      const res = await api.models.discover({ providerId: 'wlyd' });

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/models/discover');
      expect(call?.init.method).toBe('POST');
      expect(JSON.parse(call!.init.body as string)).toEqual({ providerId: 'wlyd' });
      expect(res.models).toEqual([{ id: 'deepseek-flash' }]);
    });
  });
});
