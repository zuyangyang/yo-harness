/**
 * 事件总线：内核到渲染层的单向出口。
 *
 * headless 内核不直接碰 UI，所有对外通知走总线：
 * - 'event'：落库后的完整事件信封（CLI 渲染与审计的唯一数据源）；
 * - 'llm_delta'：流式文本增量（仅实时渲染，最终文本以事件流为准）；
 * - 'status'：每次 LLM 响应后的步数 / 预算 / 上下文快照（进度条数据源）；
 * - 'turn_completed'：回合结束（reason + usage）。
 *
 * 类型化薄封装（BusEventMap 约束通道名与载荷），避免裸 EventEmitter
 * 的 string / any 签名扩散到内核。多播、同步分发、无背压 ——
 * 渲染慢不允许拖住内核（渲染层自己缓冲 / 节流）。
 */
import { EventEmitter } from 'node:events';

import type { EventEnvelope, TurnEndReason, Usage } from '../types/events.js';

/** 每步循环后的运行时快照 */
export interface AgentStatus {
  step: number;
  maxSteps: number;
  estTokens: number;
  bodyBudgetTokens: number;
  usage: Usage;
}

/** 通道 → 载荷 */
export interface BusEventMap {
  event: EventEnvelope;
  llm_delta: string;
  status: AgentStatus;
  turn_completed: { reason: TurnEndReason; usage: Usage };
}

export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(32);

  on<K extends keyof BusEventMap>(channel: K, listener: (payload: BusEventMap[K]) => void): this {
    this.emitter.on(channel, listener);
    return this;
  }

  off<K extends keyof BusEventMap>(channel: K, listener: (payload: BusEventMap[K]) => void): this {
    this.emitter.off(channel, listener);
    return this;
  }

  /** 返回是否存在订阅者（沿用 EventEmitter 语义） */
  emit<K extends keyof BusEventMap>(channel: K, payload: BusEventMap[K]): boolean {
    return this.emitter.emit(channel, payload);
  }
}
