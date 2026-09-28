/**
 * 密码哈希：argon2id。
 *
 * argon2id 抗 GPU/ASIC 暴力破解，是当前推荐的密码哈希算法。
 */
import argon2 from 'argon2';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
