/**
 * WebSocket 客户端封装：自动重连 + 心跳。
 *
 * 设计约束：
 * - 单例连接：connect() 建立连接，disconnect() 关闭
 * - 自动重连：断连后指数退避重试（1s → 2s → 4s → 8s → 最大 30s）
 * - 心跳：每 30s 发送 ping，服务端回复 pong
 * - 事件发射：内部简易 EventEmitter，发射 'event' / 'approval' / 'error' / 'connected' / 'disconnected'
 */
import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { getToken } from './client.js';

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  toolName: string;
  summary: string;
}

export interface RemoteError {
  code: string;
  message: string;
}

interface EmitterEvents {
  connected: [];
  disconnected: [];
  event: [sessionId: string, event: EventEnvelope];
  /** LLM 流式文本增量（实时渲染，不落库） */
  delta: [sessionId: string, delta: string];
  approval: [request: ApprovalRequest];
  error: [error: RemoteError];
}

type EventName = keyof EmitterEvents;
type AnyListener = (...args: unknown[]) => void;

class SimpleEmitter {
  private handlers = new Map<string, Set<AnyListener>>();

  on<K extends EventName>(event: K, fn: (...args: EmitterEvents[K]) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn as AnyListener);
  }

  off<K extends EventName>(event: K, fn: (...args: EmitterEvents[K]) => void): void {
    this.handlers.get(event)?.delete(fn as AnyListener);
  }

  emit<K extends EventName>(event: K, ...args: EmitterEvents[K]): void {
    this.handlers.get(event)?.forEach((fn) => fn(...args));
  }

  listenerCount(event: EventName): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

const PING_INTERVAL_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function getWsBaseUrl(): string {
  const httpBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? window.location.origin;
  return httpBase.replace(/^http/, 'ws');
}

export class WebSocketClient extends SimpleEmitter {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private shouldReconnect = true;
  private subscribedSessions = new Set<string>();

  connect(): void {
    if (this.ws) return;

    const token = getToken();
    if (!token) {
      this.emit('error', { code: 'NO_TOKEN', message: 'Not authenticated' });
      return;
    }

    const url = `${getWsBaseUrl()}/ws?token=${token}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.startPing();
      this.emit('connected');

      // Re-subscribe to previously subscribed sessions
      for (const sessionId of this.subscribedSessions) {
        this.sendRaw({ type: 'subscribe', sessionId });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      this.emit('disconnected');
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // error event is emitted by WebSocket; close handler will fire after
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.subscribedSessions.clear();
  }

  subscribe(sessionId: string): void {
    this.subscribedSessions.add(sessionId);
    this.sendRaw({ type: 'subscribe', sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.subscribedSessions.delete(sessionId);
    this.sendRaw({ type: 'unsubscribe', sessionId });
  }

  resolveApproval(approvalId: string, approved: boolean, scope?: 'once' | 'session'): void {
    this.sendRaw({ type: 'approval.resolve', approvalId, approved, scope });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'event':
        this.emit('event', msg.sessionId as string, msg.event as EventEnvelope);
        break;
      case 'llm.delta':
        this.emit('delta', msg.sessionId as string, msg.delta as string);
        break;
      case 'approval.request':
        this.emit('approval', {
          approvalId: msg.approvalId as string,
          sessionId: msg.sessionId as string,
          toolName: msg.toolName as string,
          summary: msg.summary as string,
        });
        break;
      case 'error':
        this.emit('error', { code: msg.code as string, message: msg.message as string });
        break;
      case 'pong':
        break;
    }
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendRaw({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }
}

export const wsClient = new WebSocketClient();
