/**
 * WebSocket Hub：连接管理 + 房间订阅 + 事件广播 + 消息处理。
 *
 * 每个 WebSocket 连接通过 subscribe 消息订阅一个或多个 sessionId（房间），
 * 服务端 AgentLoop 产生的事件通过 broadcast() 推送给房间内所有客户端。
 *
 * 审批流程：
 * 1. SessionManager 的 serverAsk 创建 PendingApproval
 * 2. Hub 通过 broadcastApprovalRequest 推送给订阅客户端
 * 3. 客户端发送 approval.resolve 消息
 * 4. Hub 调用 SessionManager.resolveApproval 解除阻塞
 */
import type { WebSocket } from 'ws';
import type { EventEnvelope } from '@yo-harness/core/types/events.js';

import type { SessionManager, PendingApproval } from '../session-manager.js';
import {
  decodeClientMessage,
  encodeServerMessage,
  type ServerMessage,
} from './protocol.js';

interface ConnectionInfo {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>;
}

export interface WebSocketHubDeps {
  sessionManager: SessionManager;
}

export class WebSocketHub {
  private readonly connections = new Map<WebSocket, ConnectionInfo>();
  private readonly rooms = new Map<string, Set<WebSocket>>();

  constructor(private readonly deps: WebSocketHubDeps) {}

  addConnection(ws: WebSocket, userId: string): void {
    const info: ConnectionInfo = { ws, userId, subscriptions: new Set() };
    this.connections.set(ws, info);

    ws.on('message', (raw: Buffer | string) => {
      this.handleMessage(info, typeof raw === 'string' ? raw : raw.toString());
    });
    ws.on('close', () => {
      this.removeConnection(ws);
    });
    ws.on('error', () => {
      this.removeConnection(ws);
    });
  }

  removeConnection(ws: WebSocket): void {
    const info = this.connections.get(ws);
    if (!info) return;

    for (const sessionId of info.subscriptions) {
      const room = this.rooms.get(sessionId);
      if (room) {
        room.delete(ws);
        if (room.size === 0) this.rooms.delete(sessionId);
      }
    }
    this.connections.delete(ws);
  }

  subscribe(ws: WebSocket, sessionId: string): void {
    const info = this.connections.get(ws);
    if (!info) return;

    info.subscriptions.add(sessionId);
    let room = this.rooms.get(sessionId);
    if (!room) {
      room = new Set();
      this.rooms.set(sessionId, room);
    }
    room.add(ws);

    // 刷新/断线重连后恢复该会话未决的审批（replayed 标记，前端按 approvalId 幂等去重）
    for (const approval of this.deps.sessionManager.getPendingApprovals(sessionId)) {
      this.sendApprovalRequest(ws, sessionId, approval, true);
    }
  }

  unsubscribe(ws: WebSocket, sessionId: string): void {
    const info = this.connections.get(ws);
    if (!info) return;

    info.subscriptions.delete(sessionId);
    const room = this.rooms.get(sessionId);
    if (room) {
      room.delete(ws);
      if (room.size === 0) this.rooms.delete(sessionId);
    }
  }

  broadcast(sessionId: string, event: EventEnvelope): void {
    const room = this.rooms.get(sessionId);
    if (!room || room.size === 0) return;

    const msg = encodeServerMessage({ type: 'event', sessionId, event });
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  }

  /** 广播 LLM 流式文本增量（不落库，仅实时渲染） */
  broadcastDelta(sessionId: string, delta: string): void {
    const room = this.rooms.get(sessionId);
    if (!room || room.size === 0) return;

    const msg = encodeServerMessage({ type: 'llm.delta', sessionId, delta });
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  }

  /**
   * 广播事件流回退：房间内所有标签页丢弃本地 seq >= fromSeq 的事件。
   *
   * 编辑 / 重试在服务端删除旧事件后调用，先于重建事件到达，避免旧的
   * 助手回复与新的回复在同一视图里叠加。
   */
  broadcastTruncated(sessionId: string, fromSeq: number): void {
    this.broadcastToRoom(sessionId, { type: 'events.truncated', sessionId, fromSeq });
  }

  /** 广播控制消息给所有连接（与 session 房间无关，如模型配置变更） */
  broadcastAll(msg: ServerMessage): void {
    const encoded = encodeServerMessage(msg);
    for (const ws of this.connections.keys()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(encoded);
      }
    }
  }

  /** 向单个连接发送审批请求（replayed=true 表示刷新/重连补发） */
  sendApprovalRequest(
    ws: WebSocket,
    sessionId: string,
    approval: PendingApproval,
    replayed = false,
  ): void {
    if (ws.readyState !== ws.OPEN) return;
    const queuePosition =
      this.deps.sessionManager.getPendingApprovals(sessionId).findIndex((a) => a.id === approval.id) + 1;
    ws.send(
      encodeServerMessage({
        type: 'approval.request',
        approvalId: approval.id,
        sessionId,
        callId: approval.callId,
        toolName: approval.toolName,
        summary: approval.summary,
        createdAt: approval.createdAt,
        ...(queuePosition > 0 ? { queuePosition } : {}),
        ...(replayed ? { replayed: true } : {}),
      }),
    );
  }

  broadcastApprovalRequest(sessionId: string, approval: PendingApproval): void {
    const room = this.rooms.get(sessionId);
    if (!room || room.size === 0) return;
    for (const ws of room) {
      this.sendApprovalRequest(ws, sessionId, approval);
    }
  }

  /** 审批已决（用户/超时/系统）→ 广播给房间，其他标签页据此出队 */
  broadcastApprovalResolved(
    sessionId: string,
    approvalId: string,
    resolution: 'once' | 'session' | 'always' | 'deny' | 'deny_and_stop',
    source: 'user' | 'timeout' | 'system',
  ): void {
    this.broadcastToRoom(sessionId, {
      type: 'approval.resolved',
      approvalId,
      sessionId,
      approved: resolution !== 'deny' && resolution !== 'deny_and_stop',
      resolution,
      source,
    });
  }

  /** 审批被取消（中断 / 关闭会话）→ 广播，避免前端残留僵尸卡片 */
  broadcastApprovalCancelled(sessionId: string, approvalId: string, reason: string): void {
    this.broadcastToRoom(sessionId, { type: 'approval.cancelled', approvalId, sessionId, reason });
  }

  private broadcastToRoom(sessionId: string, msg: ServerMessage): void {
    const room = this.rooms.get(sessionId);
    if (!room || room.size === 0) return;
    const encoded = encodeServerMessage(msg);
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) {
        ws.send(encoded);
      }
    }
  }

  sendError(ws: WebSocket, code: string, message: string): void {
    const msg = encodeServerMessage({ type: 'error', code, message });
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  getRoomSize(sessionId: string): number {
    return this.rooms.get(sessionId)?.size ?? 0;
  }

  private handleMessage(info: ConnectionInfo, raw: string): void {
    const msg = decodeClientMessage(raw);
    if (!msg) {
      this.sendError(info.ws, 'invalid_message', 'Failed to parse message');
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        this.subscribe(info.ws, msg.sessionId);
        break;
      case 'unsubscribe':
        this.unsubscribe(info.ws, msg.sessionId);
        break;
      case 'approval.resolve': {
        // 新协议优先 resolution；旧客户端回退 approved/scope
        const approved =
          msg.resolution !== undefined
            ? msg.resolution !== 'deny' && msg.resolution !== 'deny_and_stop'
            : msg.approved !== false;
        const scope =
          msg.resolution === 'session' || msg.resolution === 'always' || msg.scope === 'session'
            ? 'session'
            : 'once';
        this.deps.sessionManager.resolveApproval(msg.approvalId, approved, scope);
        break;
      }
      case 'ping':
        this.sendToWs(info.ws, { type: 'pong' });
        break;
    }
  }

  private sendToWs(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeServerMessage(msg));
    }
  }
}
