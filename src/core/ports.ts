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

// ─── Phase 2 新增端口 ───

export interface CheckpointFileInfo {
  relPath: string;
  /** 原始内容（修改前快照）；null 表示新建文件（恢复时应删除） */
  content: Buffer | null;
}

export interface CheckpointSummary {
  id: string;
  seq: number;
  source: string;
  createdAt: string;
  fileCount: number;
}

export interface CheckpointDetail {
  id: string;
  source: string;
  createdAt: string;
  files: { relPath: string; hasContent: boolean }[];
}

/** 检查点存储端口：core 定义接口，storage 实现 */
export interface CheckpointStore {
  create(input: {
    sessionId: string;
    seq: number;
    source: 'auto_write' | 'auto_undo' | 'manual';
    files: CheckpointFileInfo[];
  }): Promise<string>;

  get(checkpointId: string): Promise<CheckpointDetail | undefined>;

  listBySession(sessionId: string): Promise<CheckpointSummary[]>;

  readFileContent(checkpointId: string, relPath: string): Promise<Buffer | null>;

  getAdjacent(
    sessionId: string,
    currentSeq: number,
    direction: 'prev' | 'next',
  ): Promise<{ id: string; seq: number } | undefined>;
}
