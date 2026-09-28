/**
 * 记忆管理路由：列表 / 创建 / 更新 / 归档 / 搜索。
 */
import { Hono } from 'hono';

import type { ServerEnv } from '../types.js';
import type { StorageBackend } from '../storage/interface.js';
import type { MemoryCategory } from '@yo-harness/core/types/memory.js';
import { requirePermission } from '../auth/rbac.js';

export interface MemoriesRouteDeps {
  storage: StorageBackend;
}

export function createMemoryRoutes(deps: MemoriesRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const { storage } = deps;

  app.use('*', requirePermission('memories:read'));

  app.get('/', async (c) => {
    const store = c.get('storage');
    const memories = await store.memories.listActive();
    return c.json({ memories });
  });

  app.post('/', requirePermission('memories:write'), async (c) => {
    const store = c.get('storage');
    const body = await c.req.json<{
      title: string;
      content: string;
      category?: MemoryCategory;
      description?: string;
      keywords?: string[];
    }>();

    if (!body.title || !body.content) {
      return c.json({ error: 'title and content are required' }, 400);
    }

    const memory = await store.memories.create({
      title: body.title,
      content: body.content,
      category: body.category ?? 'general',
      description: body.description ?? '',
      keywords: body.keywords ?? [],
      status: 'active',
    });

    return c.json({ memory }, 201);
  });

  app.put('/:id', requirePermission('memories:write'), async (c) => {
    const store = c.get('storage');
    const id = c.req.param('id');
    const body = await c.req.json<{
      title?: string;
      content?: string;
      category?: MemoryCategory;
      description?: string;
      keywords?: string[];
      status?: 'active' | 'archived';
    }>();

    const memory = await store.memories.update(id, body);
    if (!memory) {
      return c.json({ error: 'memory not found' }, 404);
    }
    return c.json({ memory });
  });

  app.delete('/:id', requirePermission('memories:write'), async (c) => {
    const store = c.get('storage');
    const id = c.req.param('id');
    await store.memories.archive(id);
    return c.json({ ok: true });
  });

  app.get('/search', async (c) => {
    const store = c.get('storage');
    const query = c.req.query('q') ?? '';
    const category = c.req.query('category') as MemoryCategory | undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;

    const opts: { category?: MemoryCategory; limit?: number } = {};
    if (category !== undefined) opts.category = category;
    if (limit !== undefined) opts.limit = limit;

    const memories = await store.memories.search(query, opts);
    return c.json({ memories });
  });

  return app;
}
