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
import { ModelConfigService } from '../../src/model-config-service.js';
import { SecretCrypto } from '../../src/secret-crypto.js';
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
    invalidateSession: () => false,
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

  const modelConfig = new ModelConfigService({
    store: storage.modelConfig,
    env: {},
    crypto: new SecretCrypto('a'.repeat(64)),
  });

  ({ app } = createApp({
    storage,
    sessionManager: mockSm,
    jwtConfig,
    serverConfig,
    modelConfig,
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

  it('DELETE 真正删除会话', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    expect(await storage.sessions.get(session.id)).toBeUndefined();
  });

  it('PATCH /api/v1/sessions/:id 改名 → 200 且置 titleIsCustom', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}`, {
      method: 'PATCH',
      headers: authHeader(token),
      body: JSON.stringify({ title: '新标题' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.session.title).toBe('新标题');
    expect(body.session.titleIsCustom).toBe(true);
  });

  it('PATCH 空 title → 400', async () => {
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', type: 'interactive' });
    const res = await app.request(`/api/v1/sessions/${session.id}`, {
      method: 'PATCH',
      headers: authHeader(token),
      body: JSON.stringify({ title: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST 指定 workspaceId → 201 且写入', async () => {
    const ws = await storage.workspaces.create({ name: '工作' });
    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ workspaceId: ws.id }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.session.workspaceId).toBe(ws.id);
  });

  it('POST 指定不存在的 workspaceId → 400', async () => {
    const res = await app.request('/api/v1/sessions', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ workspaceId: 'no-such-ws' }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH model → 更新会话级模型', async () => {
    const session = await storage.sessions.create({ model: 'wlyd-llm/deepseek-flash', cwd: '/tmp' });
    const res = await app.request(`/api/v1/sessions/${session.id}`, {
      method: 'PATCH',
      headers: authHeader(token),
      body: JSON.stringify({ model: 'wlyd-llm/deepseek-v4-pro' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.session.model).toBe('wlyd-llm/deepseek-v4-pro');
    expect((await storage.sessions.get(session.id))?.model).toBe('wlyd-llm/deepseek-v4-pro');
  });

  it('PATCH 空 model → 400', async () => {
    const session = await storage.sessions.create({ model: 'm', cwd: '/tmp' });
    const res = await app.request(`/api/v1/sessions/${session.id}`, {
      method: 'PATCH',
      headers: authHeader(token),
      body: JSON.stringify({ model: '   ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('workspace routes', () => {
  it('POST /api/v1/workspaces → 201', async () => {
    const res = await app.request('/api/v1/workspaces', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({ name: '工作' }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.workspace.name).toBe('工作');
  });

  it('POST 缺 name → 400', async () => {
    const res = await app.request('/api/v1/workspaces', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/v1/workspaces → 列表（含 sessionCount）', async () => {
    const ws = await storage.workspaces.create({ name: '工作' });
    await storage.sessions.create({ model: 'default', cwd: '/tmp', workspaceId: ws.id });
    const res = await app.request('/api/v1/workspaces', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0].sessionCount).toBe(1);
  });

  it('PATCH /api/v1/workspaces/:id → 200', async () => {
    const ws = await storage.workspaces.create({ name: 'a' });
    const res = await app.request(`/api/v1/workspaces/${ws.id}`, {
      method: 'PATCH',
      headers: authHeader(token),
      body: JSON.stringify({ name: 'b' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.workspace.name).toBe('b');
  });

  it('DELETE /api/v1/workspaces/:id 解绑会话（不删除）', async () => {
    const ws = await storage.workspaces.create({ name: 'a' });
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', workspaceId: ws.id });
    const res = await app.request(`/api/v1/workspaces/${ws.id}`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    expect(await storage.workspaces.get(ws.id)).toBeUndefined();
    expect((await storage.sessions.get(session.id))?.workspaceId).toBeNull();
  });

  it('DELETE ?purge=true 级联删除会话', async () => {
    const ws = await storage.workspaces.create({ name: 'a' });
    const session = await storage.sessions.create({ model: 'default', cwd: '/tmp', workspaceId: ws.id });
    const res = await app.request(`/api/v1/workspaces/${ws.id}?purge=true`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    expect(await storage.sessions.get(session.id)).toBeUndefined();
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

  it('PUT /providers/:id 保存 provider，密钥只回传掩码', async () => {
    const put = await app.request('/api/v1/models/providers/wlyd', {
      method: 'PUT',
      headers: authHeader(token),
      body: JSON.stringify({
        kind: 'openai-compat',
        displayName: 'wlyd',
        baseURL: 'https://gateway.test/v1',
        apiKey: 'sk-super-secret-value',
        models: [{ id: 'deepseek-v4-pro' }],
      }),
    });
    expect(put.status).toBe(200);
    const putBody = await json(put);
    expect(putBody.provider.hasKey).toBe(true);
    expect(putBody.provider.apiKeyHint).toBe('sk-…alue');
    expect(JSON.stringify(putBody)).not.toContain('sk-super-secret-value');

    const list = await json(await app.request('/api/v1/models', { headers: authHeader(token) }));
    expect(list.providers).toHaveLength(1);
    expect(list.providers[0].id).toBe('wlyd');
    expect(JSON.stringify(list)).not.toContain('sk-super-secret-value');
  });

  it('PUT /providers/:id kind 非法 → 400', async () => {
    const res = await app.request('/api/v1/models/providers/bad', {
      method: 'PUT',
      headers: authHeader(token),
      body: JSON.stringify({ kind: 'grpc', baseURL: 'https://x.test' }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT /api/v1/models/active 保存后来源变为 web', async () => {
    await app.request('/api/v1/models/providers/wlyd', {
      method: 'PUT',
      headers: authHeader(token),
      body: JSON.stringify({
        kind: 'openai-compat',
        baseURL: 'https://gateway.test/v1',
        apiKey: 'sk-abcdefgh',
        models: [{ id: 'deepseek-v4-pro' }],
      }),
    });

    const res = await app.request('/api/v1/models/active', {
      method: 'PUT',
      headers: authHeader(token),
      body: JSON.stringify({ providerId: 'wlyd', model: 'deepseek-v4-pro' }),
    });
    expect(res.status).toBe(200);

    const list = await json(await app.request('/api/v1/models', { headers: authHeader(token) }));
    expect(list.source).toBe('web');
    expect(list.active).toEqual({ providerId: 'wlyd', model: 'deepseek-v4-pro' });
    // 旧字段仍然存在（向后兼容）
    expect(list.models).toHaveLength(1);
  });

  it('PUT /active 引用不存在的 provider → 400', async () => {
    const res = await app.request('/api/v1/models/active', {
      method: 'PUT',
      headers: authHeader(token),
      body: JSON.stringify({ providerId: 'ghost', model: 'm' }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /providers/:id 清空 active 并回退', async () => {
    await app.request('/api/v1/models/providers/wlyd', {
      method: 'PUT',
      headers: authHeader(token),
      body: JSON.stringify({
        kind: 'openai-compat',
        baseURL: 'https://gateway.test/v1',
        apiKey: 'sk-abcdefgh',
        models: [{ id: 'm' }],
      }),
    });
    await app.request('/api/v1/models/active', {
      method: 'PUT',
      headers: authHeader(token),
      body: JSON.stringify({ providerId: 'wlyd', model: 'm' }),
    });

    const del = await app.request('/api/v1/models/providers/wlyd', {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(del.status).toBe(200);

    const list = await json(await app.request('/api/v1/models', { headers: authHeader(token) }));
    expect(list.providers).toHaveLength(0);
    expect(list.source).not.toBe('web');
  });

  it('POST /discover 缺少 providerId 与 kind → 400', async () => {
    const res = await app.request('/api/v1/models/discover', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('viewer 不能写模型配置 → 403', async () => {
    const viewerToken = await signAccessToken({ userId, tenantId, role: 'viewer' }, jwtConfig);
    const res = await app.request('/api/v1/models/providers/x', {
      method: 'PUT',
      headers: authHeader(viewerToken),
      body: JSON.stringify({ kind: 'openai-compat', baseURL: 'https://x.test', apiKey: 'k' }),
    });
    expect(res.status).toBe(403);
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
