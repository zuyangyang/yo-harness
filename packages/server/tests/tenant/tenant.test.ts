/**
 * 多租户系统测试：AsyncLocalStorage 上下文 + AES 加密。
 */
import { describe, it, expect } from 'vitest';
import {
  runWithTenant,
  getTenantContext,
  requireTenantContext,
  tenantSchemaName,
} from '../../src/tenant/context.js';
import {
  generateEncryptionKey,
  encrypt,
  decrypt,
} from '../../src/tenant/isolation.js';

describe('tenant context', () => {
  it('runWithTenant → getTenantContext 获取正确上下文', async () => {
    const ctx = { tenantId: 't1', schemaName: 'tenant_t1' };
    await runWithTenant(ctx, async () => {
      const current = getTenantContext();
      expect(current).toBeDefined();
      expect(current!.tenantId).toBe('t1');
      expect(current!.schemaName).toBe('tenant_t1');
    });
  });

  it('无上下文时 getTenantContext 返回 undefined', () => {
    expect(getTenantContext()).toBeUndefined();
  });

  it('requireTenantContext 无上下文时抛错', () => {
    expect(() => requireTenantContext()).toThrow('no tenant context');
  });

  it('嵌套异步操作上下文不丢失', async () => {
    const ctx = { tenantId: 't2', schemaName: 'tenant_t2' };
    await runWithTenant(ctx, async () => {
      const results = await Promise.all([
        Promise.resolve().then(() => getTenantContext()),
        Promise.resolve().then(() => getTenantContext()),
      ]);
      expect(results[0]!.tenantId).toBe('t2');
      expect(results[1]!.tenantId).toBe('t2');
    });
  });

  it('setTimeout 中上下文不丢失', async () => {
    const ctx = { tenantId: 't3', schemaName: 'tenant_t3' };
    await runWithTenant(ctx, () => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const current = getTenantContext();
          expect(current!.tenantId).toBe('t3');
          resolve();
        }, 10);
      });
    });
  });

  it('tenantSchemaName 过滤非法字符', () => {
    expect(tenantSchemaName('abc-123')).toBe('tenant_abc_123');
    expect(tenantSchemaName('a.b@c')).toBe('tenant_a_b_c');
    expect(tenantSchemaName('normal_id')).toBe('tenant_normal_id');
  });
});

describe('encryption', () => {
  it('encrypt → decrypt 往返一致', () => {
    const key = generateEncryptionKey();
    const plaintext = 'hello, tenant data!';
    const ciphertext = encrypt(plaintext, key);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext, key)).toBe(plaintext);
  });

  it('错误密钥解密失败', () => {
    const key1 = generateEncryptionKey();
    const key2 = generateEncryptionKey();
    const ciphertext = encrypt('secret', key1);
    expect(() => decrypt(ciphertext, key2)).toThrow();
  });

  it('generateEncryptionKey 生成 64 字符 hex', () => {
    const key = generateEncryptionKey();
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('每次加密产生不同密文（随机 IV）', () => {
    const key = generateEncryptionKey();
    const a = encrypt('same', key);
    const b = encrypt('same', key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe('same');
    expect(decrypt(b, key)).toBe('same');
  });
});
