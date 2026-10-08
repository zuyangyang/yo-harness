/**
 * WebSocket 客户端单元测试：连接、消息路由、自动重连、心跳。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSocketClient } from '../../src/api/websocket.js';
import * as clientModule from '../../src/api/client.js';

type WsHandler = ((...args: unknown[]) => void) | null;

interface MockWebSocket {
  url: string;
  readyState: number;
  onopen: WsHandler;
  onmessage: WsHandler;
  onclose: WsHandler;
  onerror: WsHandler;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let mockWsInstances: MockWebSocket[] = [];

function createMockWebSocket(url: string): MockWebSocket {
  const ws: MockWebSocket = {
    url,
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  };
  mockWsInstances.push(ws);
  return ws;
}

function simulateOpen(ws: MockWebSocket): void {
  ws.readyState = 1;
  ws.onopen?.();
}

function simulateMessage(ws: MockWebSocket, data: unknown): void {
  ws.onmessage?.({ data: JSON.stringify(data) });
}

function simulateClose(ws: MockWebSocket): void {
  ws.readyState = 3;
  ws.onclose?.();
}

describe('WebSocketClient', () => {
  let getTokenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockWsInstances = [];
    vi.stubGlobal('WebSocket', vi.fn().mockImplementation(createMockWebSocket));
    (globalThis.WebSocket as unknown as { OPEN: number }).OPEN = 1;
    vi.useFakeTimers();
    getTokenSpy = vi.spyOn(clientModule, 'getToken').mockReturnValue('test-token');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('构造正确 URL（含 token）', () => {
      const client = new WebSocketClient();
      client.connect();

      expect(mockWsInstances).toHaveLength(1);
      expect(mockWsInstances[0]!.url).toContain('/ws?token=test-token');
    });

    it('无 token 时发射 error 事件', () => {
      getTokenSpy.mockReturnValue('');
      const client = new WebSocketClient();

      const errors: unknown[] = [];
      client.on('error', (e) => errors.push(e));
      client.connect();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({ code: 'NO_TOKEN', message: 'Not authenticated' });
    });

    it('已连接时不重复创建', () => {
      const client = new WebSocketClient();
      client.connect();
      client.connect();

      expect(mockWsInstances).toHaveLength(1);
    });

    it('连接成功后发射 connected 事件', () => {
      const client = new WebSocketClient();
      const connected: unknown[] = [];
      client.on('connected', () => connected.push(true));

      client.connect();
      simulateOpen(mockWsInstances[0]!);

      expect(connected).toHaveLength(1);
    });
  });

  describe('disconnect', () => {
    it('关闭 WebSocket 并清空实例', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      client.disconnect();

      expect(mockWsInstances[0]!.close).toHaveBeenCalled();
    });

    it('disconnect 后不自动重连', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);
      client.disconnect();

      simulateClose(mockWsInstances[0]!);
      vi.advanceTimersByTime(60_000);

      expect(mockWsInstances).toHaveLength(1);
    });

    it('清空已订阅 session', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      client.subscribe('s1');
      client.disconnect();

      // After disconnect, subscribedSessions should be empty.
      // Verify by reconnecting: no re-subscribe messages should be sent.
      (client as unknown as { shouldReconnect: boolean }).shouldReconnect = true;
      client.connect();
      simulateOpen(mockWsInstances[1]!);

      const subscribeCalls = mockWsInstances[1]!.send.mock.calls.filter(
        (c) => (c[0] as string).includes('subscribe'),
      );
      expect(subscribeCalls).toHaveLength(0);
    });
  });

  describe('message routing', () => {
    it('event 消息路由到 event 事件', () => {
      const client = new WebSocketClient();
      const events: unknown[] = [];
      client.on('event', (...args) => events.push(args));

      client.connect();
      simulateOpen(mockWsInstances[0]!);

      const envelope = { id: 1, sessionId: 's1', seq: 1, ts: '2026-01-01', payload: { type: 'turn_started', turnId: 't1' } };
      simulateMessage(mockWsInstances[0]!, { type: 'event', sessionId: 's1', event: envelope });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(['s1', envelope]);
    });

    it('llm.delta 消息路由到 delta 事件', () => {
      const client = new WebSocketClient();
      const deltas: unknown[] = [];
      client.on('delta', (...args) => deltas.push(args));

      client.connect();
      simulateOpen(mockWsInstances[0]!);

      simulateMessage(mockWsInstances[0]!, { type: 'llm.delta', sessionId: 's1', delta: '你好' });

      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toEqual(['s1', '你好']);
    });

    it('approval.request 消息路由到 approval 事件', () => {
      const client = new WebSocketClient();
      const approvals: unknown[] = [];
      client.on('approval', (req) => approvals.push(req));

      client.connect();
      simulateOpen(mockWsInstances[0]!);

      simulateMessage(mockWsInstances[0]!, {
        type: 'approval.request',
        approvalId: 'a1',
        sessionId: 's1',
        toolName: 'shell',
        summary: 'rm -rf /',
      });

      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toEqual({
        approvalId: 'a1',
        sessionId: 's1',
        toolName: 'shell',
        summary: 'rm -rf /',
      });
    });

    it('error 消息路由到 error 事件', () => {
      const client = new WebSocketClient();
      const errors: unknown[] = [];
      client.on('error', (e) => errors.push(e));

      client.connect();
      simulateOpen(mockWsInstances[0]!);

      simulateMessage(mockWsInstances[0]!, { type: 'error', code: 'FORBIDDEN', message: 'denied' });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({ code: 'FORBIDDEN', message: 'denied' });
    });

    it('pong 消息不发射任何事件', () => {
      const client = new WebSocketClient();
      const events: unknown[] = [];
      client.on('event', (...args) => events.push(args));
      client.on('approval', (req) => events.push(req));
      client.on('error', (e) => events.push(e));

      client.connect();
      simulateOpen(mockWsInstances[0]!);

      simulateMessage(mockWsInstances[0]!, { type: 'pong' });

      expect(events).toHaveLength(0);
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('subscribe 发送 subscribe 消息', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      client.subscribe('s1');

      expect(mockWsInstances[0]!.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', sessionId: 's1' }),
      );
    });

    it('unsubscribe 发送 unsubscribe 消息', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      client.unsubscribe('s1');

      expect(mockWsInstances[0]!.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'unsubscribe', sessionId: 's1' }),
      );
    });

    it('重连后自动重新订阅', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      client.subscribe('s1');
      client.subscribe('s2');

      simulateClose(mockWsInstances[0]!);

      vi.advanceTimersByTime(1000);
      expect(mockWsInstances).toHaveLength(2);
      simulateOpen(mockWsInstances[1]!);

      const sends = mockWsInstances[1]!.send.mock.calls.map((c) => c[0] as string);
      expect(sends).toContain(JSON.stringify({ type: 'subscribe', sessionId: 's1' }));
      expect(sends).toContain(JSON.stringify({ type: 'subscribe', sessionId: 's2' }));
    });
  });

  describe('resolveApproval', () => {
    it('发送 approval.resolve 消息', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      client.resolveApproval('a1', true, 'session');

      expect(mockWsInstances[0]!.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'approval.resolve', approvalId: 'a1', approved: true, scope: 'session' }),
      );
    });
  });

  describe('auto-reconnect', () => {
    it('断连后 1s 重连', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      simulateClose(mockWsInstances[0]!);

      vi.advanceTimersByTime(1000);
      expect(mockWsInstances).toHaveLength(2);
    });

    it('重连延迟指数增长', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      simulateClose(mockWsInstances[0]!);
      vi.advanceTimersByTime(500);
      expect(mockWsInstances).toHaveLength(1);

      vi.advanceTimersByTime(500);
      expect(mockWsInstances).toHaveLength(2);

      simulateClose(mockWsInstances[1]!);
      vi.advanceTimersByTime(1999);
      expect(mockWsInstances).toHaveLength(2);

      vi.advanceTimersByTime(1);
      expect(mockWsInstances).toHaveLength(3);
    });

    it('成功连接后重置延迟', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      simulateClose(mockWsInstances[0]!);
      vi.advanceTimersByTime(1000);
      simulateOpen(mockWsInstances[1]!);

      simulateClose(mockWsInstances[1]!);
      vi.advanceTimersByTime(1000);
      expect(mockWsInstances).toHaveLength(3);
    });
  });

  describe('heartbeat', () => {
    it('每 30s 发送 ping', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      vi.advanceTimersByTime(30_000);
      expect(mockWsInstances[0]!.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'ping' }),
      );

      vi.advanceTimersByTime(30_000);
      const pingCalls = mockWsInstances[0]!.send.mock.calls.filter(
        (c) => (c[0] as string).includes('ping'),
      );
      expect(pingCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('断连后停止心跳', () => {
      const client = new WebSocketClient();
      client.connect();
      simulateOpen(mockWsInstances[0]!);

      client.disconnect();
      mockWsInstances[0]!.send.mockClear();

      vi.advanceTimersByTime(60_000);
      expect(mockWsInstances[0]!.send).not.toHaveBeenCalledWith(
        expect.stringContaining('ping'),
      );
    });
  });
});
