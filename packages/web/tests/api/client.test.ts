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
      expect(headers['Authorization']).toBe('Bearer mytoken');
    });

    it('无 token 时不附加 Authorization', async () => {
      mockFetchResponse({});
      await fetchJson('GET', '/test');

      const call = lastFetchCall();
      const headers = call!.init.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
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
      await api.sessions.list(10);

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions?limit=10');
    });

    it('create 发送 model/cwd', async () => {
      mockFetchResponse({ session: { id: 's1' } });
      await api.sessions.create('gpt-4', '/tmp');

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ model: 'gpt-4', cwd: '/tmp' });
    });

    it('sendMessage 发送 content', async () => {
      mockFetchResponse({});
      await api.sessions.sendMessage('s1', 'hello');

      const call = lastFetchCall();
      expect(call?.url).toBe('/api/v1/sessions/s1/messages');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ content: 'hello' });
    });
  });
});
