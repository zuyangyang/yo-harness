/**
 * 内核端口（依赖倒置）。
 *
 * core/ 只依赖这里定义的接口；storage / llm / tools 提供实现并在
 * 装配层（cli/runtime）注入。这是"内核无头化"的边界保证，
 * 由 eslint no-restricted-imports 强制。
 */
import type { AgentEvent, EventEnvelope } from '../types/events.js';
import type { Tool, ToolSpec } from '../types/tools.js';

export interface EventStore {
  append(sessionId: string, event: AgentEvent): Promise<EventEnvelope>;
  /** 按 seq 升序返回全部事件（会话恢复 / 重放校验用） */
  replay(sessionId: string): Promise<EventEnvelope[]>;
  lastSeq(sessionId: string): Promise<number>;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  cwd: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface SessionStore {
  create(input: { model: string; cwd: string; title?: string }): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  listRecent(limit: number): Promise<Session[]>;
  /** 刷新 updated_at（每次 turn 结束后调用，供 resume 列表排序） */
  touch(id: string): Promise<void>;
  updateTitle(id: string, title: string): Promise<void>;
}

/** 工具解析端口：AgentLoop 经此取工具与规格，不依赖具体注册表 */
export interface ToolResolver {
  get(name: string): Tool | undefined;
  specs(): ToolSpec[];
}
