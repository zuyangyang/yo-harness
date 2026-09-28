/**
 * Hono 应用级类型定义。
 *
 * ServerEnv 定义 Hono 中间件通过 c.set/c.get 传递的请求级变量，
 * 所有路由工厂使用 Hono<ServerEnv> 确保类型安全。
 */
import type { StorageBackend } from './storage/interface.js';
import type { AuthInfo } from './auth/middleware.js';

export interface ServerEnv {
  Variables: {
    storage: StorageBackend;
    auth: AuthInfo;
  };
}
