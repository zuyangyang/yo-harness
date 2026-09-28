/**
 * WebSocket Hub 单元测试：连接管理、房间订阅、广播、消息处理。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebSocketHub } from '../../src/ws/hub.js';
import type { SessionManager } from '../../src/session-manager.js';
import type { WebSocket } from 'ws';
import type { EventEnvelope } from '@yo-harness/core/types/events.js';

type WsCallback = (...args: any[]) => void;

interface MockWebSocket {
  ws: WebSocket;
  listeners: Map<string, WsCallback[]>;
  sent: string[];
  readyState: number;
  simulateMessage(data: string): void;
  simulateClose(): void;
}

function createMockWebSocket(): MockWebSocket {
  const listeners = new Map<string, WsCallback[]>();
  const sent: string[] = [];
  const mock: MockWebSocket = {
    ws: null as unknown as WebSocket,
    listeners,
    sent,
    readyState: 1, // OPEN
    simulateMessage(data: string) {
      const cbs = listeners.get('message') ?? [];
      for (const cb of cbs) { cb(Buffer.from(data)); }
    },
    simulateClose() {
      mock.readyState = 3; // CLOSED
      const cbs = listeners.get('close') ?? [];
      for (const cb of cbs) { cb(); }
    },
  };

  const ws = {
    on(event: string, cb: WsCallback) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    },
    send(data: string) { sent.push(data); },
    get readyState() { return mock.readyState; },
    OPEN: 1,
  } as unknown as WebSocket;

  mock.ws = ws;
  return mock;
}

function mockSessionManager(): SessionManager {
  return {
    resolveApproval: vi.fn().mockReturnValue(true),
  } as unknown as SessionManager;
}

const fakeEvent: EventEnvelope = {
  id: 'e1',
  sessionId: 's1',
  type: 'assistant.text',
  timestamp: Date.now(),
  data: { text: 'hello' },
};

let hub: WebSocketHub;
let sm: SessionManager;

beforeEach(() => {
  sm = mockSessionManager();
  hub = new WebSocketHub({ sessionManager: sm });
});

describe('连接管理', () => {
  it('addConnection 后 connectionCount +1', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    expect(hub.connectionCount).toBe(1);
  });

  it('removeConnection 后 connectionCount -1', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    hub.removeConnection(m.ws);
    expect(hub.connectionCount).toBe(0);
  });

  it('ws close 事件自动移除连接', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    m.simulateClose();
    expect(hub.connectionCount).toBe(0);
  });

  it('多个连接独立计数', () => {
    const m1 = createMockWebSocket();
    const m2 = createMockWebSocket();
    hub.addConnection(m1.ws, 'u1');
    hub.addConnection(m2.ws, 'u2');
    expect(hub.connectionCount).toBe(2);
    hub.removeConnection(m1.ws);
    expect(hub.connectionCount).toBe(1);
  });
});

describe('房间订阅', () => {
  it('subscribe 后 getRoomSize +1', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    hub.subscribe(m.ws, 's1');
    expect(hub.getRoomSize('s1')).toBe(1);
  });

  it('unsubscribe 后 getRoomSize -1', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    hub.subscribe(m.ws, 's1');
    hub.unsubscribe(m.ws, 's1');
    expect(hub.getRoomSize('s1')).toBe(0);
  });

  it('removeConnection 自动清理房间', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    hub.subscribe(m.ws, 's1');
    hub.removeConnection(m.ws);
    expect(hub.getRoomSize('s1')).toBe(0);
  });

  it('同一连接可订阅多个 session', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    hub.subscribe(m.ws, 's1');
    hub.subscribe(m.ws, 's2');
    expect(hub.getRoomSize('s1')).toBe(1);
    expect(hub.getRoomSize('s2')).toBe(1);
  });

  it('未订阅的 session roomSize 为 0', () => {
    expect(hub.getRoomSize('nonexistent')).toBe(0);
  });
});

describe('广播', () => {
  it('broadcast 推送给房间内所有客户端', () => {
    const m1 = createMockWebSocket();
    const m2 = createMockWebSocket();
    hub.addConnection(m1.ws, 'u1');
    hub.addConnection(m2.ws, 'u2');
    hub.subscribe(m1.ws, 's1');
    hub.subscribe(m2.ws, 's1');

    hub.broadcast('s1', fakeEvent);

    expect(m1.sent).toHaveLength(1);
    expect(m2.sent).toHaveLength(1);
    const parsed = JSON.parse(m1.sent[0]);
    expect(parsed.type).toBe('event');
    expect(parsed.sessionId).toBe('s1');
  });

  it('broadcast 不推送给未订阅的客户端', () => {
    const m1 = createMockWebSocket();
    const m2 = createMockWebSocket();
    hub.addConnection(m1.ws, 'u1');
    hub.addConnection(m2.ws, 'u2');
    hub.subscribe(m1.ws, 's1');

    hub.broadcast('s1', fakeEvent);

    expect(m1.sent).toHaveLength(1);
    expect(m2.sent).toHaveLength(0);
  });

  it('broadcast 到空房间不报错', () => {
    expect(() => hub.broadcast('empty', fakeEvent)).not.toThrow();
  });

  it('broadcast 跳过非 OPEN 状态的连接', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    hub.subscribe(m.ws, 's1');
    m.readyState = 3; // CLOSED

    hub.broadcast('s1', fakeEvent);

    expect(m.sent).toHaveLength(0);
  });

  it('broadcastApprovalRequest 推送审批请求', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    hub.subscribe(m.ws, 's1');

    hub.broadcastApprovalRequest('s1', {
      id: 'a1',
      toolName: 'Bash',
      summary: 'rm -rf /',
      createdAt: Date.now(),
      resolve: () => {},
    });

    expect(m.sent).toHaveLength(1);
    const parsed = JSON.parse(m.sent[0]);
    expect(parsed.type).toBe('approval.request');
    expect(parsed.approvalId).toBe('a1');
    expect(parsed.toolName).toBe('Bash');
  });
});

describe('客户端消息处理', () => {
  it('subscribe 消息 → 加入房间', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    m.simulateMessage('{"type":"subscribe","sessionId":"s1"}');
    expect(hub.getRoomSize('s1')).toBe(1);
  });

  it('unsubscribe 消息 → 离开房间', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    hub.subscribe(m.ws, 's1');
    m.simulateMessage('{"type":"unsubscribe","sessionId":"s1"}');
    expect(hub.getRoomSize('s1')).toBe(0);
  });

  it('ping 消息 → 回复 pong', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    m.simulateMessage('{"type":"ping"}');
    expect(m.sent).toHaveLength(1);
    const parsed = JSON.parse(m.sent[0]);
    expect(parsed.type).toBe('pong');
  });

  it('approval.resolve 消息 → 调用 sessionManager.resolveApproval', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    m.simulateMessage('{"type":"approval.resolve","approvalId":"a1","approved":true}');
    expect(sm.resolveApproval).toHaveBeenCalledWith('a1', true, 'once');
  });

  it('approval.resolve 带 scope → 传递 scope', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    m.simulateMessage('{"type":"approval.resolve","approvalId":"a1","approved":false,"scope":"session"}');
    expect(sm.resolveApproval).toHaveBeenCalledWith('a1', false, 'session');
  });

  it('无效 JSON → 回复 error', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    m.simulateMessage('not json');
    expect(m.sent).toHaveLength(1);
    const parsed = JSON.parse(m.sent[0]);
    expect(parsed.type).toBe('error');
    expect(parsed.code).toBe('invalid_message');
  });

  it('未知 type → 回复 error', () => {
    const m = createMockWebSocket();
    hub.addConnection(m.ws, 'u1');
    m.simulateMessage('{"type":"unknown"}');
    expect(m.sent).toHaveLength(1);
    const parsed = JSON.parse(m.sent[0]);
    expect(parsed.type).toBe('error');
  });
});
