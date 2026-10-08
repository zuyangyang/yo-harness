/**
 * WebSocket 消息协议定义。
 *
 * 客户端 → 服务端：subscribe / unsubscribe / approval.resolve / ping
 * 服务端 → 客户端：event / approval.request / error / pong
 */
import type { EventEnvelope } from '@yo-harness/core/types/events.js';

// ─── 客户端 → 服务端 ───

export interface SubscribeMessage {
  type: 'subscribe';
  sessionId: string;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  sessionId: string;
}

export interface ApprovalResolveMessage {
  type: 'approval.resolve';
  approvalId: string;
  approved: boolean;
  scope?: 'once' | 'session';
}

export interface PingMessage {
  type: 'ping';
}

export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | ApprovalResolveMessage
  | PingMessage;

// ─── 服务端 → 客户端 ───

export interface EventMessage {
  type: 'event';
  sessionId: string;
  event: EventEnvelope;
}

export interface ApprovalRequestMessage {
  type: 'approval.request';
  approvalId: string;
  sessionId: string;
  toolName: string;
  summary: string;
}

/**
 * LLM 流式文本增量 —— 实时渲染用，不落库。
 *
 * 最终文本始终以 `assistant_text` 事件为准；该消息只用于结果生成过程中的
 * 渐进展示，客户端在收到 assistant_text 后应丢弃当前累积。
 */
export interface LlmDeltaMessage {
  type: 'llm.delta';
  sessionId: string;
  delta: string;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

/** 模型配置在服务端发生变更（前端据此刷新「当前模型」显示） */
export interface ModelConfigChangedMessage {
  type: 'model_config_changed';
  providerId: string;
  model: string;
  source: string;
}

export type ServerMessage =
  | EventMessage
  | LlmDeltaMessage
  | ApprovalRequestMessage
  | ErrorMessage
  | PongMessage
  | ModelConfigChangedMessage;

// ─── 工具函数 ───

export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as Record<string, unknown>).type;
  return type === 'subscribe' || type === 'unsubscribe' || type === 'approval.resolve' || type === 'ping';
}

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isClientMessage(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
