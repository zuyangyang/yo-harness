import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SecretCrypto,
  createSecretCrypto,
  maskSecret,
  normalizeMasterKey,
  resolveMasterKey,
} from '../src/secret-crypto.js';
import { FatalError } from '@yo-harness/core/types/errors.js';

const HEX_KEY = 'a'.repeat(64);
const HEX_KEY_2 = 'b'.repeat(64);
const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-secret-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SecretCrypto', () => {
  it('加解密往返', () => {
    const crypto = new SecretCrypto(HEX_KEY);
    const cipher = crypto.encrypt('sk-super-secret');
    expect(cipher).not.toContain('sk-super-secret');
    expect(crypto.decrypt(cipher)).toBe('sk-super-secret');
  });

  it('相同明文两次加密结果不同（随机 IV）', () => {
    const crypto = new SecretCrypto(HEX_KEY);
    expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
  });

  it('换密钥解密失败 → undefined', () => {
    const cipher = new SecretCrypto(HEX_KEY).encrypt('sk-x');
    expect(new SecretCrypto(HEX_KEY_2).decrypt(cipher)).toBeUndefined();
  });

  it('损坏密文解密失败 → undefined', () => {
    const crypto = new SecretCrypto(HEX_KEY);
    expect(crypto.decrypt('not-base64!!')).toBeUndefined();
    expect(crypto.decrypt('')).toBeUndefined();
  });

  it('hint 返回掩码', () => {
    expect(new SecretCrypto(HEX_KEY).hint('sk-1234567890c0eA')).toBe('sk-…c0eA');
  });
});

describe('normalizeMasterKey', () => {
  it('接受 64 位 hex 并小写归一', () => {
    expect(normalizeMasterKey('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('接受 32 字节 base64', () => {
    expect(normalizeMasterKey(BASE64_KEY)).toHaveLength(64);
  });

  it('非法输入抛 FatalError', () => {
    expect(() => normalizeMasterKey('too-short')).toThrow(FatalError);
  });
});

describe('resolveMasterKey', () => {
  it('优先使用 YO_SECRET_KEY（hex）', () => {
    expect(resolveMasterKey({ env: { YO_SECRET_KEY: HEX_KEY }, keyPath: join(dir, 'k') })).toBe(HEX_KEY);
  });

  it('支持 base64 形式的 YO_SECRET_KEY', () => {
    expect(resolveMasterKey({ env: { YO_SECRET_KEY: BASE64_KEY }, keyPath: join(dir, 'k') })).toBe(
      Buffer.alloc(32, 7).toString('hex'),
    );
  });

  it('无 YO_SECRET_KEY 时生成密钥文件（0600）并复用', () => {
    const keyPath = join(dir, 'nested', 'secret.key');
    const first = resolveMasterKey({ env: {}, keyPath });
    const second = resolveMasterKey({ env: {}, keyPath });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('createSecretCrypto 端到端可用', () => {
    const crypto = createSecretCrypto({ env: { YO_SECRET_KEY: HEX_KEY } });
    expect(crypto.decrypt(crypto.encrypt('sk-live'))).toBe('sk-live');
  });
});

describe('maskSecret', () => {
  it('长密钥保留首 3 与末 4 位', () => {
    expect(maskSecret('sk-abcdefghijklmnop')).toBe('sk-…mnop');
    expect(maskSecret('sk-ZfMrBYvnWR1XIyAK6D9se6FUnbUG5z63hGetA4OWfC0eAOkH')).toBe('sk-…AOkH');
  });

  it('短密钥不泄露', () => {
    expect(maskSecret('short')).toBe('…');
    expect(maskSecret('')).toBe('…');
  });
});
