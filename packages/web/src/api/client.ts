/**
 * REST API 客户端：fetch 封装 + JWT 自动附加。
 *
 * 设计约束：
 * - 单例 token 管理：setToken 由 auth store 调用，所有请求自动附加 Authorization header
 * - 统一错误处理：HTTP 错误抛 ApiError（带 status + message），业务层按需 catch
 * - 类型安全：泛型 T 指定响应体结构，避免 any
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken = '';

export function setToken(token: string): void {
  accessToken = token;
}

export function clearToken(): void {
  accessToken = '';
}

export function getToken(): string {
  return accessToken;
}

const DEFAULT_BASE_URL = '';

function getBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_BASE_URL;
}

export async function fetchJson<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }
  return res.json() as Promise<T>;
}

// ─── 业务 API ───

export interface LoginRequest {
  tenantId: string;
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; role: string };
}

export interface RegisterRequest {
  tenantId: string;
  username: string;
  password: string;
  email?: string;
}

export type SessionStatus = 'active' | 'archived';
export type SessionType = 'interactive' | 'background';
export type PermissionMode = 'ask' | 'auto' | 'full';

export interface Session {
  id: string;
  title: string;
  model: string;
  cwd: string;
  status: SessionStatus;
  type: SessionType;
  workspaceId: string | null;
  pinned: boolean;
  titleIsCustom: boolean;
  /** 会话级权限模式；null = 继承工作区/全局默认 */
  permissionMode: PermissionMode | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListParams {
  /** null = 仅独立会话（无工作区） */
  workspaceId?: string | null;
  status?: SessionStatus;
  q?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

export interface SessionUpdateInput {
  title?: string;
  workspaceId?: string | null;
  pinned?: boolean;
  status?: SessionStatus;
  /** 会话级模型（"providerId/modelId"）；null = 清空，回落全局默认 */
  model?: string | null;
  /** 会话级权限模式；null = 清空，回落到默认 */
  permissionMode?: PermissionMode | null;
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
  sessionCount?: number;
}

export type MemoryCategory = 'preference' | 'environment' | 'project_knowledge' | 'general';
export type MemoryStatus = 'active' | 'archived';

export interface Memory {
  id: string;
  title: string;
  content: string;
  category: MemoryCategory;
  description: string;
  keywords: string[];
  status: MemoryStatus;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTask {
  id: string;
  sessionId: string;
  description: string;
  status: BackgroundTaskStatus;
  pid: number | null;
  endReason: string | null;
  completedAt: string | null;
  summary: string | null;
  errorMessage: string | null;
  createdAt: string;
  cwd: string;
  model: string;
}

export interface ModelInfo {
  provider: string;
  model: string;
  contextWindow: number;
}

export interface ModelRole {
  role: string;
  provider: string;
  model: string;
}

export type ProviderKind = 'openai-compat' | 'anthropic';
export type ConfigSource = 'web' | 'env' | 'file' | 'default';

export interface ModelDescriptor {
  id: string;
  contextWindow?: number;
}

export interface ProviderProfile {
  id: string;
  displayName: string;
  kind: ProviderKind;
  baseURL: string | undefined;
  hasKey: boolean;
  apiKeyHint: string | undefined;
  models: ModelDescriptor[];
  sortOrder: number;
}

export interface ModelSelection {
  providerId: string;
  model: string;
}

export interface ModelConfigView {
  source: ConfigSource;
  active: ModelSelection;
  providers: ProviderProfile[];
  warnings: string[];
  /** 旧字段：服务端 config 里声明的模型，保留兼容 */
  models: ModelInfo[];
  roles: ModelRole[];
}

export interface SaveProviderInput {
  kind: ProviderKind;
  displayName?: string;
  baseURL?: string;
  /** 非空 = 覆盖密钥；空/缺省 = 保留已有密钥 */
  apiKey?: string;
  apiKeyEnv?: string | null;
  models?: ModelDescriptor[];
  defaultContextWindow?: number;
  sortOrder?: number;
}

export interface DiscoverModelsInput {
  providerId?: string;
  kind?: ProviderKind;
  baseURL?: string;
  apiKey?: string;
}

export type ApprovalResolution = 'once' | 'session' | 'always' | 'deny' | 'deny_and_stop';

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  callId?: string;
  toolName: string;
  summary: string;
  createdAt?: string;
  expiresAt?: string;
  args?: Record<string, unknown>;
}

export const api = {
  auth: {
    login: (req: LoginRequest) => fetchJson<LoginResponse>('POST', '/auth/login', req),
    register: (req: RegisterRequest) => fetchJson<LoginResponse>('POST', '/auth/register', req),
    refresh: (refreshToken: string) =>
      fetchJson<{ accessToken: string }>('POST', '/auth/refresh', { refreshToken }),
    me: () => fetchJson<{ user: { id: string; username: string; role: string } }>('GET', '/auth/me'),
  },
  sessions: {
    list: (params: SessionListParams = {}) => {
      const qs = new URLSearchParams();
      if (params.workspaceId === null) qs.set('workspaceId', 'none');
      else if (params.workspaceId !== undefined) qs.set('workspaceId', params.workspaceId);
      if (params.status !== undefined) qs.set('status', params.status);
      if (params.q !== undefined) qs.set('q', params.q);
      if (params.pinned !== undefined) qs.set('pinned', String(params.pinned));
      qs.set('limit', String(params.limit ?? 50));
      if (params.offset !== undefined) qs.set('offset', String(params.offset));
      return fetchJson<{ sessions: Session[] }>('GET', `/api/v1/sessions?${qs}`);
    },
    get: (id: string) => fetchJson<{ session: Session }>('GET', `/api/v1/sessions/${id}`),
    create: (input: { model?: string; cwd?: string; workspaceId?: string | null } = {}) =>
      fetchJson<{ session: Session }>('POST', '/api/v1/sessions', input),
    update: (id: string, patch: SessionUpdateInput) =>
      fetchJson<{ session: Session }>('PATCH', `/api/v1/sessions/${id}`, patch),
    delete: (id: string) => fetchJson<void>('DELETE', `/api/v1/sessions/${id}`),
    sendMessage: (id: string, content: string) =>
      fetchJson<void>('POST', `/api/v1/sessions/${id}/messages`, { content }),
    getEvents: (id: string) =>
      fetchJson<{ events: unknown[] }>('GET', `/api/v1/sessions/${id}/events`),
    /** 重新生成：回退到指定 user_input 并重发原文 */
    regenerateTurn: (id: string, seq: number) =>
      fetchJson<{ accepted: true; fromSeq: number }>(
        'POST',
        `/api/v1/sessions/${id}/turns/${seq}/regenerate`,
      ),
    /** 编辑重发：回退到指定 user_input 并以新内容重新运行 */
    editTurn: (id: string, seq: number, content: string) =>
      fetchJson<{ accepted: true; fromSeq: number }>(
        'POST',
        `/api/v1/sessions/${id}/turns/${seq}/edit`,
        { content },
      ),
    interrupt: (id: string) => fetchJson<void>('POST', `/api/v1/sessions/${id}/interrupt`),
    getPendingApprovals: (id: string) =>
      fetchJson<{ approvals: PendingApproval[] }>('GET', `/api/v1/sessions/${id}/approvals/pending`),
  },
  workspaces: {
    list: () => fetchJson<{ workspaces: Workspace[] }>('GET', '/api/v1/workspaces'),
    get: (id: string) => fetchJson<{ workspace: Workspace }>('GET', `/api/v1/workspaces/${id}`),
    create: (input: { name: string; description?: string; color?: string; icon?: string }) =>
      fetchJson<{ workspace: Workspace }>('POST', '/api/v1/workspaces', input),
    update: (id: string, patch: Partial<Pick<Workspace, 'name' | 'description' | 'color' | 'icon' | 'sortOrder'>>) =>
      fetchJson<{ workspace: Workspace }>('PATCH', `/api/v1/workspaces/${id}`, patch),
    delete: (id: string, purge = false) =>
      fetchJson<{ ok: boolean }>('DELETE', `/api/v1/workspaces/${id}${purge ? '?purge=true' : ''}`),
  },
  approvals: {
    resolve: (approvalId: string, resolution: ApprovalResolution) =>
      fetchJson<{ ok: boolean }>('POST', `/api/v1/approvals/${approvalId}/resolve`, { resolution }),
  },
  memories: {
    list: () => fetchJson<{ memories: Memory[] }>('GET', '/api/v1/memories'),
    search: (q: string, category?: MemoryCategory, limit?: number) => {
      const params = new URLSearchParams({ q });
      if (category) params.set('category', category);
      if (limit !== undefined) params.set('limit', String(limit));
      return fetchJson<{ memories: Memory[] }>('GET', `/api/v1/memories/search?${params}`);
    },
    create: (input: { title: string; content: string; category?: MemoryCategory; description?: string; keywords?: string[] }) =>
      fetchJson<{ memory: Memory }>('POST', '/api/v1/memories', input),
    update: (id: string, patch: Partial<Pick<Memory, 'title' | 'content' | 'category' | 'description' | 'keywords' | 'status'>>) =>
      fetchJson<{ memory: Memory }>('PUT', `/api/v1/memories/${id}`, patch),
    delete: (id: string) => fetchJson<{ ok: boolean }>('DELETE', `/api/v1/memories/${id}`),
  },
  tasks: {
    list: (limit = 20) => fetchJson<{ tasks: BackgroundTask[] }>('GET', `/api/v1/tasks?limit=${limit}`),
    get: (id: string) => fetchJson<{ task: BackgroundTask }>('GET', `/api/v1/tasks/${id}`),
    cancel: (id: string) => fetchJson<{ ok: boolean }>('POST', `/api/v1/tasks/${id}/cancel`),
  },
  models: {
    list: () => fetchJson<ModelConfigView>('GET', '/api/v1/models'),
    saveProvider: (id: string, input: SaveProviderInput) =>
      fetchJson<{ provider: ProviderProfile }>('PUT', `/api/v1/models/providers/${encodeURIComponent(id)}`, input),
    deleteProvider: (id: string) =>
      fetchJson<{ ok: boolean }>('DELETE', `/api/v1/models/providers/${encodeURIComponent(id)}`),
    saveActive: (selection: ModelSelection) =>
      fetchJson<{ ok: boolean; active: ModelSelection }>('PUT', '/api/v1/models/active', selection),
    discover: (input: DiscoverModelsInput) =>
      fetchJson<{ models: ModelDescriptor[] }>('POST', '/api/v1/models/discover', input),
  },
};
