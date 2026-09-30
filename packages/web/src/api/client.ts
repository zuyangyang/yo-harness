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

export interface Session {
  id: string;
  title: string | null;
  model: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
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

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  toolName: string;
  summary: string;
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
    list: (limit = 20) => fetchJson<{ sessions: Session[] }>('GET', `/api/v1/sessions?limit=${limit}`),
    get: (id: string) => fetchJson<{ session: Session }>('GET', `/api/v1/sessions/${id}`),
    create: (model?: string, cwd?: string) =>
      fetchJson<{ session: Session }>('POST', '/api/v1/sessions', { model, cwd }),
    delete: (id: string) => fetchJson<void>('DELETE', `/api/v1/sessions/${id}`),
    sendMessage: (id: string, content: string) =>
      fetchJson<void>('POST', `/api/v1/sessions/${id}/messages`, { content }),
    getEvents: (id: string) =>
      fetchJson<{ events: unknown[] }>('GET', `/api/v1/sessions/${id}/events`),
    interrupt: (id: string) => fetchJson<void>('POST', `/api/v1/sessions/${id}/interrupt`),
    getPendingApprovals: (id: string) =>
      fetchJson<{ approvals: PendingApproval[] }>('GET', `/api/v1/sessions/${id}/approvals/pending`),
  },
  approvals: {
    resolve: (approvalId: string, approved: boolean, scope?: 'once' | 'session') =>
      fetchJson<{ ok: boolean }>('POST', `/api/v1/approvals/${approvalId}/resolve`, { approved, scope }),
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
    list: () => fetchJson<{ models: ModelInfo[]; roles: ModelRole[] }>('GET', '/api/v1/models'),
  },
};
