/**
 * REST API 集成测试：通过 Hono app.request() 测试完整路由。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteBackend } from '../../src/storage/sqlite.js';
import type { StorageBackend } from '../../src/storage/interface.js';
import { createJwtConfig, signAccessToken } from '../../src/auth/jwt.js';
import { hashPassword } from '../../src/auth/password.js';
import { createApp } from '../../src/app.js';
import { createDefaultServerConfig } from '../../src/config.js';
import type { SessionManager } from '../../src/session-manager.js';
import { WebSocketHub } from '../../src/ws/hub.js';
import type { Hono } from 'hono';
import type { ServerEnv } from '../../src/types.js';

let storage: StorageBackend;
let app: Hono<ServerEnv>;
let token: string;
let userId: string;
let tenantId: string;

const jwtConfig = createJwtConfig({ secret: 'test-secret' });

async function json<T = Record<string, any>>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function mockSessionManager(): SessionManager {
  return {
    sendMessage: async () => ({ accepted: true as const }),
    interrupt: () => {},
    getPendingApprovals: () => [],
    resolveApproval: () => false,
    closeSession: () => {},
    destroyAll: async () => {},
  } as unknown as SessionManager;
}

const authHeader = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

beforeEach(async () => {
  storage = createSqliteBackend(':memory:');
  await storage.initialize();

  tenantId = 'test-tenant';
  const pwHash = await hashPassword('test-pw');
  const user = await storage.users.create({
    tenantId,
    username: 'tester',
    password: pwHash,
    role: 'member',
  });
  userId = user.id;

  token = await signAccessToken(
    { userId, tenantId, role: 'member' },
    jwtConfig,
  );

  const serverConfig = createDefaultServerConfig({
    providers: [{ provider: 'test', model: 'test-model', contextWindow: 4096 }],
    modelRoles: { main: { provider: 'test', model: 'test-model' } },
  });

  const mockSm = mockSessionManager();
  const wsHub = new WebSocketHub({ sessionManager: mockSm });

  ({ app } = createApp({
    storage,
    sessionManager: mockSm,
    jwtConfig,
    serverConfig,
    wsHub,
  }));
});

describe('health checks', () => {
  it('GET /health → 200', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('ok');
  });

  it('GET /ready → 200', async () => {
    const res = await app.request('/ready');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('ready');
  });
});

describe('auth middleware', () => {
  it('无 token 访问受保护路由 → 401', async () => {
    const res = await app.request('/api/v1/sessions');
    expect(res.status).toBe(401);
  });

  it('无效 token → 401', async () => {
    const res = await app.request('/api/v1/sessions', {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    expect(res.status).toBe(401);
  });
});

describe('auth routes', () => {
  it('POST /auth/register → 201', async () => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'new-tenant',
        username: 'newuser',
        password: 'new-pw',
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.user.username).toBe('newuser');
  });

  it('POST /auth/register 重复用户名 → 409', async () => {
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        username: 'tester',
        password: 'pw',
      }),
    });
    expect(res.status).toBe(409);
  });

  it('POST /auth/login → 200 + tokens', async () => {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        username: 'tester',
        password: 'test-pw',
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
  });

  it('POST /auth/login 错误密码 → 401', async () => {
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId,
        username: 'tester',
        password: 'wrong-pw',
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe('session routes', () => {
  it('POST /api/v1/sessions → 201', async () => {
    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ title: 'Test Session' }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.session).toBeDefined();
    expect(body.session.title).toBe('Test Session');
  });

  it('GET /api/v1/sessions → 列表', async () => {
    await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request('/api/v1/sessions', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/sessions/:id → 详情', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.session.id).toBe(session.id);
  });

  it('GET /api/v1/sessions/:id 不存在 → 404', async () => {
    const res = await app.request('/api/v1/sessions/nonexistent', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/v1/sessions/:id → 200', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });
});

describe('conversation routes', () => {
  it('POST /api/v1/sessions/:id/messages → 202', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.accepted).toBe(true);
  });

  it('POST messages 空 content → 400', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ content: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/sessions/:id/events → 事件列表', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}/events`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.events).toEqual([]);
  });

  it('POST /api/v1/sessions/:id/interrupt → 200', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}/interrupt`, {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
  });
});

describe('approval routes', () => {
  it('GET /api/v1/sessions/:id/approvals/pending → 空列表', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}/approvals/pending`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.approvals).toEqual([]);
  });

  it('POST /api/v1/approvals/:id/resolve 不存在 → 404', async () => {
    const res = await app.request('/api/v1/approvals/nonexistent/resolve', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(404);
  });

  it('POST resolve 缺少 approved → 400', async () => {
    const res = await app.request('/api/v1/approvals/some-id/resolve', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('task routes', () => {
  it('GET /api/v1/tasks → 列表', async () => {
    const res = await app.request('/api/v1/tasks', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.tasks).toEqual([]);
  });

  it('GET /api/v1/tasks/:id 不存在 → 404', async () => {
    const res = await app.request('/api/v1/tasks/nonexistent', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(404);
  });
});

describe('memory routes', () => {
  it('POST /api/v1/memories → 201', async () => {
    const res = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ title: 'Test Memory', content: 'Some content' }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.memory.title).toBe('Test Memory');
  });

  it('POST memories 缺 title → 400', async () => {
    const res = await app.request('/api/v1/memories', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ title: '', content: 'Some content' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/memories → 列表', async () => {
    await storage.memories.create({
      title: 'M1', content: 'C1', category: 'general', description: '', keywords: [], status: 'active',
    });
    const res = await app.request('/api/v1/memories', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.memories.length).toBe(1);
  });

  it('GET /api/v1/memories/search → 搜索', async () => {
    await storage.memories.create({
      title: 'Search Me', content: 'findable', category: 'general', description: '', keywords: ['test'], status: 'active',
    });
    const res = await app.request('/api/v1/memories/search?q=findable', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.memories.length).toBe(1);
  });
});

describe('model routes', () => {
  it('GET /api/v1/models → 模型列表', async () => {
    const res = await app.request('/api/v1/models', {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.models).toHaveLength(1);
    expect(body.models[0].provider).toBe('test');
    expect(body.roles).toHaveLength(1);
    expect(body.roles[0].role).toBe('main');
  });
});

describe('RBAC', () => {
  it('viewer 不能创建 session', async () => {
    const viewerToken = await signAccessToken(
      { userId, tenantId, role: 'viewer' },
      jwtConfig,
    );
    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: authHeader(viewerToken),
      body: JSON.stringify({ title: 'Should Fail' }),
    });
    expect(res.status).toBe(403);
  });
});
