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

export type ApprovalResolution = 'once' | 'session' | 'always' | 'deny' | 'deny_and_stop';
export type ApprovalSource = 'user' | 'timeout' | 'system';

export interface ApprovalResolveMessage {
  type: 'approval.resolve';
  approvalId: string;
  /** 新协议：显式裁决；缺省时回退 approved/scope（旧客户端兼容） */
  resolution?: ApprovalResolution;
  approved?: boolean;
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

/** 触发人工审批的风险摘要（供审批卡展示「为什么需要确认」） */
export interface ApprovalRiskSummary {
  level: 'none' | 'low' | 'medium' | 'high';
  reasons: string[];
  ruleIds: string[];
}

export interface ApprovalRequestMessage {
  type: 'approval.request';
  approvalId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  summary: string;
  risk?: ApprovalRiskSummary;
  options?: ApprovalResolution[];
  createdAt?: string;
  expiresAt?: string;
  /** 同会话队列中的位置（从 1 开始） */
  queuePosition?: number;
  /** 刷新/断线重连时补发 */
  replayed?: boolean;
}

/** 审批已决（含超时/系统）——所有标签页据此出队 */
export interface ApprovalResolvedMessage {
  type: 'approval.resolved';
  approvalId: string;
  sessionId: string;
  approved: boolean;
  resolution: ApprovalResolution;
  source: ApprovalSource;
}

/** 审批被取消（中断 / 关闭会话） */
export interface ApprovalCancelledMessage {
  type: 'approval.cancelled';
  approvalId: string;
  sessionId: string;
  reason: string;
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
  | ApprovalResolvedMessage
  | ApprovalCancelledMessage
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
