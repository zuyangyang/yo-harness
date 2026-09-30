/**
 * createServer 装配冒烟测试。
 *
 * app.test.ts 直接调用 createApp，不覆盖 index.ts 里的运行时装配
 * （ModelConfigService + SessionManager 访问器 + 路由挂载）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultServerConfig } from '../../src/config.js';
import { createServer } from '../../src/index.js';
import { createSqliteBackend } from '../../src/storage/sqlite.js';
import type { StorageBackend } from '../../src/storage/interface.js';

let storage: StorageBackend | undefined;

afterEach(async () => {
  await storage?.close();
  storage = undefined;
});

describe('createServer 装配', () => {
  it('完成装配、模型路由已挂载（未鉴权返回 401）且默认走 Fake 运行时', async () => {
    // 避免在开发机 ~/.yo-harness 下生成密钥文件
    process.env.YO_SECRET_KEY = 'a'.repeat(64);

    storage = createSqliteBackend(':memory:');
    const server = await createServer({
      storage,
      serverConfig: createDefaultServerConfig(),
      jwtSecret: 'test-secret',
    });

    const res = await server.app.request('/api/v1/models');
    expect(res.status).toBe(401);

    // 无任何 provider 配置 → 回退内置默认（anthropic），无密钥 → Fake
    const runtime = await server.modelConfig.getRuntime();
    expect(runtime.providerId).toBe('anthropic');
    expect(runtime.source).toBe('default');
    expect(runtime.isFake).toBe(true);
  });
});
