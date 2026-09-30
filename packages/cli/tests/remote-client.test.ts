/**
 * RemoteClient 单元测试：mock fetch + WebSocket，验证 HTTP 请求格式、
 * WebSocket 消息路由、事件发射、断连处理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteClient } from '../src/remote-client.js';

vi.mock('ws', () => {
  const instances: unknown[] = [];
  const MockWebSocket = vi.fn(function (this: unknown) {
    const instance = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
    instances.push(instance);
    return instance;
  });
  (MockWebSocket as unknown as Record<string, unknown>).OPEN = 1;
  (MockWebSocket as unknown as Record<string, unknown>).instances = instances;
  return { default: MockWebSocket };
});

const SERVER = 'http://localhost:3000';

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

describe('RemoteClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeClient(): RemoteClient {
    return new RemoteClient({
      serverUrl: SERVER,
      tenantId: 'tenant-1',
      username: 'alice',
      password: 'secret',
    });
  }

  describe('login()', () => {
    it('POST /auth/login 并存储 token', async () => {
      mockFetchResponse({
        accessToken: 'tok-abc',
        refreshToken: 'ref-xyz',
        user: { id: 'u1', username: 'alice', role: 'member' },
      });

      const client = makeClient();
      const result = await client.login();

      expect(result.accessToken).toBe('tok-abc');
      expect(client.token).toBe('tok-abc');

      const call = lastFetchCall();
      expect(call?.url).toBe(`${SERVER}/auth/login`);
      expect(call?.init.method).toBe('POST');
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ tenantId: 'tenant-1', username: 'alice', password: 'secret' });
    });

    it('HTTP 错误抛异常', async () => {
      mockFetchResponse({ error: 'unauthorized' }, 401);
      const client = makeClient();
      await expect(client.login()).rejects.toThrow('HTTP 401');
    });
  });

  describe('session methods', () => {
    let client: RemoteClient;

    beforeEach(async () => {
      mockFetchResponse({
        accessToken: 'tok',
        refreshToken: 'ref',
        user: { id: 'u1', username: 'alice', role: 'member' },
      });
      client = makeClient();
      await client.login();
    });

    it('createSession() 发送 model/cwd', async () => {
      const session = {
        id: 'sess-1',
        title: null,
        model: 'gpt-4',
        cwd: '/tmp',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      };
      mockFetchResponse({ session });

      const result = await client.createSession('gpt-4', '/tmp');
      expect(result.id).toBe('sess-1');

      const call = lastFetchCall();
      expect(call?.url).toBe(`${SERVER}/api/v1/sessions`);
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ model: 'gpt-4', cwd: '/tmp' });
    });

    it('listSessions() GET 带 limit', async () => {
      mockFetchResponse({ sessions: [] });
      await client.listSessions(5);

      const call = lastFetchCall();
      expect(call?.url).toBe(`${SERVER}/api/v1/sessions?limit=5`);
      expect(call?.init.method).toBe('GET');
    });

    it('getSession() GET /:id', async () => {
      const session = {
        id: 'sess-1',
        title: 'test',
        model: 'gpt-4',
        cwd: '/tmp',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      };
      mockFetchResponse({ session });
      const result = await client.getSession('sess-1');
      expect(result.id).toBe('sess-1');

      const call = lastFetchCall();
      expect(call?.url).toBe(`${SERVER}/api/v1/sessions/sess-1`);
    });

    it('sendMessage() POST content', async () => {
      mockFetchResponse({});
      await client.sendMessage('sess-1', 'hello');

      const call = lastFetchCall();
      expect(call?.url).toBe(`${SERVER}/api/v1/sessions/sess-1/messages`);
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ content: 'hello' });
    });

    it('getEvents() GET events', async () => {
      mockFetchResponse({ events: [] });
      const events = await client.getEvents('sess-1');
      expect(events).toEqual([]);

      const call = lastFetchCall();
      expect(call?.url).toBe(`${SERVER}/api/v1/sessions/sess-1/events`);
    });

    it('resolveApproval() POST approved', async () => {
      mockFetchResponse({});
      await client.resolveApproval('appr-1', true, 'session');

      const call = lastFetchCall();
      expect(call?.url).toBe(`${SERVER}/api/v1/approvals/appr-1/resolve`);
      const body = JSON.parse(call!.init.body as string);
      expect(body).toEqual({ approved: true, scope: 'session' });
    });

    it('interrupt() POST', async () => {
      mockFetchResponse({});
      await client.interrupt('sess-1');

      const call = lastFetchCall();
      expect(call?.url).toBe(`${SERVER}/api/v1/sessions/sess-1/interrupt`);
    });

    it('所有请求带 Authorization header', async () => {
      mockFetchResponse({ sessions: [] });
      await client.listSessions();

      const call = lastFetchCall();
      const headers = call!.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok');
    });
  });

  describe('WebSocket message routing', () => {
    async function getMockWs(): Promise<{
      client: RemoteClient;
      handlers: Record<string, (...args: unknown[]) => void>;
      mockWs: { on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
    }> {
      const wsModule = await import('ws');
      const MockWebSocket = wsModule.default as unknown as {
        new(url: string): { on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        instances: unknown[];
      };
      (MockWebSocket.instances).length = 0;

      const client = makeClient();
      (client as unknown as { accessToken: string }).accessToken = 'tok';
      client.connectWebSocket();

      const mockWs = (MockWebSocket.instances as { on: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number }[])[0]!;
      const handlers: Record<string, (...args: unknown[]) => void> = {};
      for (const call of mockWs.on.mock.calls) {
        handlers[call[0] as string] = call[1] as (...args: unknown[]) => void;
      }
      return { client, handlers, mockWs };
    }

    it('message 路由 event 事件', async () => {
      const { client, handlers } = await getMockWs();

      const received: unknown[] = [];
      client.on('event', (...args) => received.push(args));

      const messageHandler = handlers.message as (raw: { toString(): string }) => void;
      const envelope = { id: 1, sessionId: 's1', seq: 1, ts: '2026-01-01', payload: { type: 'turn_started' as const, turnId: 't1' } };
      messageHandler({ toString: () => JSON.stringify({ type: 'event', sessionId: 's1', event: envelope }) });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(['s1', envelope]);
    });

    it('message 路由 approval 事件', async () => {
      const { client, handlers } = await getMockWs();

      const approvals: unknown[] = [];
      client.on('approval', (req) => approvals.push(req));

      const messageHandler = handlers.message as (raw: { toString(): string }) => void;
      messageHandler({
        toString: () =>
          JSON.stringify({
            type: 'approval.request',
            approvalId: 'a1',
            sessionId: 's1',
            toolName: 'shell',
            summary: 'rm -rf /',
          }),
      });

      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toEqual({
        approvalId: 'a1',
        sessionId: 's1',
        toolName: 'shell',
        summary: 'rm -rf /',
      });
    });

    it('message 路由 error 事件', async () => {
      const { client, handlers } = await getMockWs();

      const errors: unknown[] = [];
      client.on('error', (err) => errors.push(err));

      const messageHandler = handlers.message as (raw: { toString(): string }) => void;
      messageHandler({
        toString: () => JSON.stringify({ type: 'error', code: 'NOT_FOUND', message: 'session not found' }),
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({ code: 'NOT_FOUND', message: 'session not found' });
    });

    it('message 忽略 pong', async () => {
      const { client, handlers } = await getMockWs();

      const received: unknown[] = [];
      client.on('event', (...args) => received.push(args));

      const messageHandler = handlers.message as (raw: { toString(): string }) => void;
      messageHandler({ toString: () => JSON.stringify({ type: 'pong' }) });

      expect(received).toHaveLength(0);
    });

    it('message 忽略畸形 JSON', async () => {
      const { handlers } = await getMockWs();

      const messageHandler = handlers.message as (raw: { toString(): string }) => void;
      expect(() => messageHandler({ toString: () => 'not json' })).not.toThrow();
    });

    it('subscribe 发送 WebSocket 消息', async () => {
      const { client, mockWs } = await getMockWs();
      client.subscribe('sess-1');
      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', sessionId: 'sess-1' }));
    });

    it('unsubscribe 发送 WebSocket 消息', async () => {
      const { client, mockWs } = await getMockWs();
      client.unsubscribe('sess-1');
      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'unsubscribe', sessionId: 'sess-1' }));
    });

    it('disconnect 关闭 WebSocket', async () => {
      const { client, mockWs } = await getMockWs();
      client.disconnect();
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('close 触发 disconnected 事件', async () => {
      const { client, handlers } = await getMockWs();

      let disconnected = false;
      client.on('disconnected', () => { disconnected = true; });

      const closeHandler = handlers.close as () => void;
      closeHandler();

      expect(disconnected).toBe(true);
    });

    it('sendWs 在 ws 未连接时不发送', async () => {
      const { client, mockWs } = await getMockWs();
      mockWs.readyState = 3; // CLOSED
      client.subscribe('sess-1');
      expect(mockWs.send).not.toHaveBeenCalled();
    });
  });
});
