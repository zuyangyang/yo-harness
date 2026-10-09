/**
 * 内核端口（依赖倒置）。
 *
 * core/ 只依赖这里定义的接口；storage / llm / tools 提供实现并在
 * 装配层（cli/runtime）注入。这是"内核无头化"的边界保证，
 * 由 eslint no-restricted-imports 强制。
 */
import type { AgentEvent, EventEnvelope } from '../types/events.js';
import type { PermissionMode } from './permission.js';
import type { Memory, MemoryCategory, MemoryStatus } from '../types/memory.js';
import type { Tool, ToolSpec } from '../types/tools.js';
import type { BackgroundTask, BackgroundTaskStatus, CreateTaskInput } from '../daemon/types.js';
import type { ModelSelection, ProviderRecord, ProviderRecordInput } from '../types/model-config.js';

export interface EventStore {
  append(sessionId: string, event: AgentEvent): Promise<EventEnvelope>;
  /** 按 seq 升序返回全部事件（会话恢复 / 重放校验用） */
  replay(sessionId: string): Promise<EventEnvelope[]>;
  lastSeq(sessionId: string): Promise<number>;
  /**
   * 删除 seq >= fromSeq 的事件（编辑 / 重试时回退到某条 user_input 之前）。
   * 追加写不变量在回退这一显式动作处放宽：调用方负责丢弃的内存状态
   * （活跃 loop 的 ContextManager）由 SessionManager 负责驱逐重建。
   * @param sessionId - 目标会话。
   * @param fromSeq - 起始 seq（含）；删除该 seq 及其之后的全部事件。
   * @returns 实际删除的事件条数。
   */
  deleteFrom(sessionId: string, fromSeq: number): Promise<number>;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  cwd: string;
  status: 'active' | 'archived';
  type: 'interactive' | 'background';
  workspaceId: string | null;
  pinned: boolean;
  titleIsCustom: boolean;
  /** 会话级权限模式；null = 继承工作区/全局默认 */
  permissionMode: PermissionMode | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListFilter {
  /** null = 仅独立会话（workspace_id IS NULL）；缺省 = 全部 */
  workspaceId?: string | null;
  /** 缺省 = active */
  status?: 'active' | 'archived';
  /** 标题模糊匹配 */
  query?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface SessionUpdate {
  title?: string;
  titleIsCustom?: boolean;
  workspaceId?: string | null;
  pinned?: boolean;
  status?: 'active' | 'archived';
  /** 会话级模型（形如 "providerId/modelId"）；null = 清空，回落到全局默认模型 */
  model?: string | null;
  /** 会话级权限模式；null = 清空，回落到工作区/全局默认 */
  permissionMode?: PermissionMode | null;
}

export interface SessionStore {
  create(input: {
    model: string;
    cwd: string;
    title?: string;
    titleIsCustom?: boolean;
    workspaceId?: string | null;
    type?: 'interactive' | 'background';
    permissionMode?: PermissionMode | null;
  }): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  /** 带过滤/分页的列表（listRecent 的泛化） */
  list(filter?: SessionListFilter): Promise<Session[]>;
  /** 最近 N 个 active 会话（兼容 CLI） */
  listRecent(limit: number): Promise<Session[]>;
  /** 刷新 updated_at（每次 turn 结束后调用，供 resume 列表排序） */
  touch(id: string): Promise<void>;
  update(id: string, patch: SessionUpdate): Promise<Session | undefined>;
  /** 仅设置标题，不改变 titleIsCustom（供自动命名使用）；用户改名请走 update + titleIsCustom:true */
  updateTitle(id: string, title: string): Promise<void>;
  /** 物理删除 + 级联清理关联数据（events / checkpoints / tasks；memories 解绑） */
  delete(id: string): Promise<void>;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** 该工作区下 active 会话数（仅列表接口返回） */
  sessionCount?: number;
}

export interface WorkspaceStore {
  create(input: {
    name: string;
    description?: string;
    color?: string;
    icon?: string;
    sortOrder?: number;
  }): Promise<Workspace>;
  get(id: string): Promise<Workspace | undefined>;
  update(
    id: string,
    patch: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'sortOrder'>>,
  ): Promise<Workspace | undefined>;
  /** 删除工作区；其下会话 workspace_id → NULL（不删会话） */
  delete(id: string): Promise<void>;
  list(): Promise<Workspace[]>;
}

/** 工具解析端口：AgentLoop 经此取工具与规格，不依赖具体注册表 */
export interface ToolResolver {
  get(name: string): Tool | undefined;
  /** mode=compact 时 inputSchema 精简到顶层属性名 */
  specs(mode?: 'full' | 'compact'): ToolSpec[];
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

// ─── Phase 3 新增端口 ───

export interface MemorySearchOptions {
  category?: MemoryCategory;
  status?: MemoryStatus;
  limit?: number;
}

/** 语义记忆存储端口：core 定义接口，storage 实现 */
export interface MemoryStore {
  create(input: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Memory>;
  get(id: string): Promise<Memory | undefined>;
  update(id: string, patch: Partial<Pick<Memory, 'title' | 'content' | 'category' | 'description' | 'keywords' | 'status'>>): Promise<Memory | undefined>;
  archive(id: string): Promise<void>;
  listActive(): Promise<Memory[]>;
  search(query: string, options?: MemorySearchOptions): Promise<Memory[]>;
}

// ─── Phase 3 后台任务端口 ───

export interface TaskStore {
  create(input: CreateTaskInput): Promise<BackgroundTask>;
  get(id: string): Promise<BackgroundTask | undefined>;
  list(limit?: number): Promise<BackgroundTask[]>;
  updateStatus(
    id: string,
    status: BackgroundTaskStatus,
    endReason?: BackgroundTask['endReason'],
    errorMessage?: string,
    summary?: string,
  ): Promise<void>;
}

// ─── Phase 6 模型配置端口 ───

/**
 * Web UI 模型配置存储端口。
 *
 * 只负责持久化 Provider 档案与当前选择；凭据的加解密由 server 层完成
 * （core 收到的是密文或环境变量名，从不接触明文）。
 */
export interface ModelConfigStore {
  listProviders(): Promise<ProviderRecord[]>;
  getProvider(id: string): Promise<ProviderRecord | undefined>;
  /** 新增或覆盖；已存在时保留 createdAt，仅刷新 updatedAt */
  upsertProvider(input: ProviderRecordInput): Promise<ProviderRecord>;
  deleteProvider(id: string): Promise<void>;
  /** 当前选择的 provider + 模型；未配置时 undefined */
  getSettings(): Promise<ModelSelection | undefined>;
  saveSettings(selection: ModelSelection): Promise<void>;
  /** 清空当前选择（回退到 .env 解析） */
  clearSettings(): Promise<void>;
}
