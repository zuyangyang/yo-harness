/**
 * 鉴权系统测试：密码哈希、JWT、RBAC、完整登录流程。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteBackend } from '../../src/storage/sqlite.js';
import type { StorageBackend } from '../../src/storage/interface.js';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  createJwtConfig,
} from '../../src/auth/jwt.js';
import { hasPermission } from '../../src/auth/rbac.js';
import type { AuthInfo } from '../../src/auth/middleware.js';

let storage: StorageBackend;

beforeEach(async () => {
  storage = createSqliteBackend(':memory:');
  await storage.initialize();
});

describe('password hashing', () => {
  it('hash → verify 正确密码通过', async () => {
    const hash = await hashPassword('test-password');
    expect(hash).not.toBe('test-password');
    expect(await verifyPassword(hash, 'test-password')).toBe(true);
  });

  it('错误密码拒绝', async () => {
    const hash = await hashPassword('correct');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });
});

describe('JWT', () => {
  const jwtConfig = createJwtConfig({ secret: 'test-secret' });

  it('签发 → 校验 access token', async () => {
    const token = await signAccessToken(
      { userId: 'u1', tenantId: 't1', role: 'member' },
      jwtConfig,
    );
    const payload = await verifyToken(token, jwtConfig);
    expect(payload.userId).toBe('u1');
    expect(payload.tenantId).toBe('t1');
    expect(payload.role).toBe('member');
  });

  it('签发 → 校验 refresh token', async () => {
    const token = await signRefreshToken(
      { userId: 'u1', tenantId: 't1' },
      jwtConfig,
    );
    const payload = await verifyToken(token, jwtConfig);
    expect(payload.userId).toBe('u1');
    expect(payload.role).toBe('refresh');
  });

  it('过期 token 拒绝', async () => {
    const shortLived = createJwtConfig({ secret: 'test-secret', accessTokenTtl: '0s' });
    const token = await signAccessToken(
      { userId: 'u1', tenantId: 't1', role: 'member' },
      shortLived,
    );

    await expect(verifyToken(token, shortLived)).rejects.toThrow();
  });

  it('错误 secret 拒绝', async () => {
    const other = createJwtConfig({ secret: 'other-secret' });
    const token = await signAccessToken(
      { userId: 'u1', tenantId: 't1', role: 'member' },
      jwtConfig,
    );
    await expect(verifyToken(token, other)).rejects.toThrow();
  });
});

describe('RBAC', () => {
  it('viewer 只能读', () => {
    const viewer: AuthInfo = { userId: 'u1', tenantId: 't1', role: 'viewer' };
    expect(hasPermission(viewer, 'sessions:read')).toBe(true);
    expect(hasPermission(viewer, 'sessions:write')).toBe(false);
    expect(hasPermission(viewer, 'admin')).toBe(false);
  });

  it('member 可读写但不可管理', () => {
    const member: AuthInfo = { userId: 'u1', tenantId: 't1', role: 'member' };
    expect(hasPermission(member, 'sessions:read')).toBe(true);
    expect(hasPermission(member, 'sessions:write')).toBe(true);
    expect(hasPermission(member, 'users:manage')).toBe(false);
  });

  it('admin 全部权限', () => {
    const admin: AuthInfo = { userId: 'u1', tenantId: 't1', role: 'admin' };
    expect(hasPermission(admin, 'sessions:read')).toBe(true);
    expect(hasPermission(admin, 'users:manage')).toBe(true);
    expect(hasPermission(admin, 'admin')).toBe(true);
  });
});

describe('UserStore', () => {
  it('创建 → 查找 → 列出', async () => {
    const hash = await hashPassword('pw');
    const user = await storage.users.create({
      tenantId: 't1',
      username: 'alice',
      password: hash,
      role: 'member',
    });

    expect(user.id).toBeDefined();
    expect(user.username).toBe('alice');

    const found = await storage.users.findByUsername('t1', 'alice');
    expect(found).toBeDefined();
    expect(found!.username).toBe('alice');

    const list = await storage.users.listByTenant('t1');
    expect(list).toHaveLength(1);
  });

  it('不同租户同名用户互不干扰', async () => {
    const hash = await hashPassword('pw');
    await storage.users.create({ tenantId: 't1', username: 'alice', password: hash, role: 'member' });
    await storage.users.create({ tenantId: 't2', username: 'alice', password: hash, role: 'admin' });

    const u1 = await storage.users.findByUsername('t1', 'alice');
    const u2 = await storage.users.findByUsername('t2', 'alice');
    expect(u1!.role).toBe('member');
    expect(u2!.role).toBe('admin');
  });
});

describe('ApiKeyStore', () => {
  it('创建 → 校验 → 撤销', async () => {
    const hash = await hashPassword('pw');
    const user = await storage.users.create({
      tenantId: 't1', username: 'bob', password: hash, role: 'member',
    });

    const { apiKey, rawKey } = await storage.apiKeys.create({
      tenantId: 't1',
      userId: user.id,
      name: 'test-key',
      role: 'member',
    });

    expect(rawKey).toMatch(/^yoh_/);
    expect(apiKey.name).toBe('test-key');

    const verified = await storage.apiKeys.verifyByKey(rawKey);
    expect(verified).not.toBeNull();
    expect(verified!.id).toBe(apiKey.id);

    const keys = await storage.apiKeys.listByUser(user.id);
    expect(keys).toHaveLength(1);

    await storage.apiKeys.revoke(apiKey.id);
    const after = await storage.apiKeys.listByUser(user.id);
    expect(after).toHaveLength(0);
  });

  it('错误 key 返回 null', async () => {
    const result = await storage.apiKeys.verifyByKey('yoh_nonexistent');
    expect(result).toBeNull();
  });
});

describe('完整登录流程', () => {
  const jwtConfig = createJwtConfig({ secret: 'integration-test' });

  it('注册 → 登录 → 带 token 访问 → 刷新', async () => {
    const password = 'my-secret-pw';
    const hash = await hashPassword(password);

    await storage.users.create({
      tenantId: 't1',
      username: 'charlie',
      password: hash,
      role: 'member',
    });

    const user = await storage.users.findByUsername('t1', 'charlie');
    expect(user).toBeDefined();

    const valid = await verifyPassword(user!.passwordHash, password);
    expect(valid).toBe(true);

    const accessToken = await signAccessToken(
      { userId: user!.id, tenantId: user!.tenantId, role: user!.role },
      jwtConfig,
    );

    const payload = await verifyToken(accessToken, jwtConfig);
    expect(payload.userId).toBe(user!.id);
    expect(payload.role).toBe('member');

    const refreshToken = await signRefreshToken(
      { userId: user!.id, tenantId: user!.tenantId },
      jwtConfig,
    );
    const refreshPayload = await verifyToken(refreshToken, jwtConfig);
    expect(refreshPayload.role).toBe('refresh');

    const newAccess = await signAccessToken(
      { userId: refreshPayload.userId, tenantId: refreshPayload.tenantId, role: user!.role },
      jwtConfig,
    );
    const newPayload = await verifyToken(newAccess, jwtConfig);
    expect(newPayload.userId).toBe(user!.id);
  });
});
