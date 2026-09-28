/**
 * RemoteClient：CLI 远程模式客户端。
 *
 * 通过 HTTP REST + WebSocket 连接远端 yo-server，
 * 实现会话管理、消息发送、事件流接收、审批交互。
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';

export interface RemoteClientOptions {
  serverUrl: string;
  tenantId: string;
  username: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; role: string };
}

export interface RemoteSession {
  id: string;
  title: string | null;
  model: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface RemoteClientEvents {
  event: (sessionId: string, envelope: EventEnvelope) => void;
  approval: (req: ApprovalRequest) => void;
  error: (err: RemoteError) => void;
  disconnected: () => void;
}

export class RemoteClient extends EventEmitter {
  private readonly serverUrl: string;
  private readonly credentials: { tenantId: string; username: string; password: string };
  private accessToken = '';
  private refreshToken = '';
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RemoteClientOptions) {
    super();
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.credentials = {
      tenantId: options.tenantId,
      username: options.username,
      password: options.password,
    };
  }

  get token(): string {
    return this.accessToken;
  }

  async login(): Promise<LoginResult> {
    const res = await this.fetchJson<LoginResult>('POST', '/auth/login', {
      tenantId: this.credentials.tenantId,
      username: this.credentials.username,
      password: this.credentials.password,
    });
    this.accessToken = res.accessToken;
    this.refreshToken = res.refreshToken;
    return res;
  }

  async createSession(model?: string, cwd?: string): Promise<RemoteSession> {
    const body = await this.fetchJson<{ session: RemoteSession }>('POST', '/api/v1/sessions', {
      model,
      cwd,
    });
    return body.session;
  }

  async listSessions(limit = 20): Promise<RemoteSession[]> {
    const body = await this.fetchJson<{ sessions: RemoteSession[] }>(
      'GET',
      `/api/v1/sessions?limit=${limit}`,
    );
    return body.sessions;
  }

  async getSession(id: string): Promise<RemoteSession> {
    const body = await this.fetchJson<{ session: RemoteSession }>('GET', `/api/v1/sessions/${id}`);
    return body.session;
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    await this.fetchJson('POST', `/api/v1/sessions/${sessionId}/messages`, { content });
  }

  async getEvents(sessionId: string): Promise<EventEnvelope[]> {
    const body = await this.fetchJson<{ events: EventEnvelope[] }>(
      'GET',
      `/api/v1/sessions/${sessionId}/events`,
    );
    return body.events;
  }

  async resolveApproval(approvalId: string, approved: boolean, scope?: 'once' | 'session'): Promise<void> {
    await this.fetchJson('POST', `/api/v1/approvals/${approvalId}/resolve`, { approved, scope });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.fetchJson('POST', `/api/v1/sessions/${sessionId}/interrupt`);
  }

  connectWebSocket(): void {
    const wsUrl = this.serverUrl.replace(/^http/, 'ws') + `/ws?token=${this.accessToken}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.pingTimer = setInterval(() => {
        this.sendWs({ type: 'ping' });
      }, 30_000);
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        switch (msg.type) {
          case 'event':
            this.emit('event', msg.sessionId as string, msg.event as EventEnvelope);
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
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      this.stopPing();
      this.emit('disconnected');
    });

    this.ws.on('error', () => {
      // error event is emitted by ws; close handler will fire after
    });
  }

  subscribe(sessionId: string): void {
    this.sendWs({ type: 'subscribe', sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.sendWs({ type: 'unsubscribe', sessionId });
  }

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private sendWs(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async fetchJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}
