/**
 * Provider API key 的静态加密（设计文档 docs/MODEL-CONFIG-DESIGN.md §6）。
 *
 * 复用 core/tenant 已有的 AES-256-GCM 原语，这里只负责：
 * - 主密钥解析：优先 YO_SECRET_KEY（64 位 hex 或 32 字节 base64），
 *   否则在 ~/.yo-harness/secret.key 生成并复用（权限 0600）；
 * - 解密失败安全降级为 undefined（由解析层回退 .env，而不是抛错崩溃）；
 * - 展示用掩码，任何地方都不回传明文。
 *
 * 注意：主密钥必须延迟解析——服务进程只是启动时不应该生成密钥文件，
 * 只有真正保存 / 读取凭据时才需要。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { FatalError } from '@yo-harness/core/types/errors.js';
import { yoHome } from '@yo-harness/core/utils/paths.js';

import { decrypt as aesDecrypt, encrypt as aesEncrypt, generateEncryptionKey } from './tenant/isolation.js';

const KEY_BYTES = 32;
const KEY_FILE_MODE = 0o600;
export const DEFAULT_KEY_FILE_NAME = 'secret.key';

/** 校验并归一化为 64 位 hex 主密钥 */
export function normalizeMasterKey(raw: string): string {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();

  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === KEY_BYTES) return decoded.toString('hex');

  throw new FatalError(
    'YO_SECRET_KEY must be a 32-byte key encoded as 64 hex chars or base64;\n' +
      `  got ${trimmed.length} chars. Generate one with: openssl rand -hex 32`,
  );
}

function readOrCreateKeyFile(keyPath: string): string {
  if (existsSync(keyPath)) {
    return normalizeMasterKey(readFileSync(keyPath, 'utf8'));
  }

  const keyHex = generateEncryptionKey();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, `${keyHex}\n`, { mode: KEY_FILE_MODE });
  chmodSync(keyPath, KEY_FILE_MODE);
  return keyHex;
}

/**
 * 解析主密钥。env 传入而非直接读 process.env，便于测试与注入。
 * 优先级：YO_SECRET_KEY > 密钥文件（不存在则生成）。
 */
export function resolveMasterKey(opts: { env?: Record<string, string | undefined>; keyPath?: string } = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env.YO_SECRET_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return normalizeMasterKey(fromEnv);
  }
  return readOrCreateKeyFile(opts.keyPath ?? join(yoHome(), DEFAULT_KEY_FILE_NAME));
}

/** 展示用掩码：保留首 3 与末 4 位，形如 sk-…c0eA */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return '…';
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

export class SecretCrypto {
  readonly keyHex: string;

  constructor(keyHex: string) {
    const normalized = normalizeMasterKey(keyHex);
    if (Buffer.from(normalized, 'hex').length !== KEY_BYTES) {
      throw new FatalError('invalid master key length');
    }
    this.keyHex = normalized;
  }

  encrypt(plaintext: string): string {
    return aesEncrypt(plaintext, this.keyHex);
  }

  /** 解密失败（密钥不匹配 / 数据损坏）返回 undefined，由调用方回退 */
  decrypt(ciphertext: string): string | undefined {
    try {
      return aesDecrypt(ciphertext, this.keyHex);
    } catch {
      return undefined;
    }
  }

  hint(plaintext: string): string {
    return maskSecret(plaintext);
  }
}

/** 便捷工厂：按需解析主密钥 */
export function createSecretCrypto(opts: { env?: Record<string, string | undefined>; keyPath?: string } = {}): SecretCrypto {
  return new SecretCrypto(resolveMasterKey(opts));
}
