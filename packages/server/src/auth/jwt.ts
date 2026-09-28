/**
 * JWT 签发 / 校验 / 刷新（jose 库）。
 *
 * 使用 HS256（HMAC + SHA-256）对称签名。
 * 生产环境可切换为 RS256（非对称）——只需替换 secret → privateKey/publicKey。
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export interface JwtPayload extends JWTPayload {
  userId: string;
  tenantId: string;
  role: 'admin' | 'member' | 'viewer' | 'refresh';
}

export interface JwtConfig {
  secret: string;
  accessTokenTtl: string;
  refreshTokenTtl: string;
}

const DEFAULT_CONFIG: JwtConfig = {
  secret: process.env.JWT_SECRET ?? 'yo-harness-dev-secret-change-me',
  accessTokenTtl: '15m',
  refreshTokenTtl: '7d',
};

export function createJwtConfig(overrides?: Partial<JwtConfig>): JwtConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export async function signAccessToken(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  config: JwtConfig = DEFAULT_CONFIG,
): Promise<string> {
  const secret = new TextEncoder().encode(config.secret);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.accessTokenTtl)
    .sign(secret);
}

export async function signRefreshToken(
  payload: { userId: string; tenantId: string },
  config: JwtConfig = DEFAULT_CONFIG,
): Promise<string> {
  const secret = new TextEncoder().encode(config.secret);
  return new SignJWT({ ...payload, role: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.refreshTokenTtl)
    .sign(secret);
}

export async function verifyToken(token: string, config: JwtConfig = DEFAULT_CONFIG): Promise<JwtPayload> {
  const secret = new TextEncoder().encode(config.secret);
  const { payload } = await jwtVerify(token, secret);
  return payload as JwtPayload;
}
