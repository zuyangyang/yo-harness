/**
 * resolveSession 单测：精确匹配 + 前缀匹配 + 边界条件。
 */
import { describe, expect, it } from 'vitest';

import type { Session, SessionStore } from '../../src/core/ports.js';
import { resolveSession } from '../../src/cli/runtime.js';

/** 构造一个最小 SessionStore 替身 */
function mockStore(sessions: Session[]): SessionStore {
  return {
    create: () => Promise.reject(new Error('not implemented')),
    get: (id: string) => Promise.resolve(sessions.find((s) => s.id === id)),
    listRecent: (limit: number) => Promise.resolve(sessions.slice(0, limit)),
    touch: () => Promise.resolve(),
    updateTitle: () => Promise.resolve(),
  };
}

function makeSession(id: string, title = 'test'): Session {
  return {
    id,
    title,
    model: 'anthropic/claude-sonnet-4-5',
    cwd: '/tmp',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveSession', () => {
  const s1 = makeSession('aaaaaaaa-1111-2222-3333-444444444444');
  const s2 = makeSession('bbbbbbbb-1111-2222-3333-444444444444');
  const s3 = makeSession('bbbbbbbb-5555-6666-7777-888888888888');

  it('精确匹配完整 UUID', async () => {
    const store = mockStore([s1, s2]);
    const result = await resolveSession(store, s1.id);
    expect(result).toBe(s1);
  });

  it('8 字符前缀唯一匹配', async () => {
    const store = mockStore([s1, s2]);
    const result = await resolveSession(store, 'aaaaaaaa');
    expect(result).toBe(s1);
  });

  it('前缀匹配到多个会话 → 返回 undefined（歧义）', async () => {
    const store = mockStore([s2, s3]);
    const result = await resolveSession(store, 'bbbbbbbb');
    expect(result).toBeUndefined();
  });

  it('前缀过短（< 8 字符）→ 不做前缀匹配，返回 undefined', async () => {
    const store = mockStore([s1]);
    const result = await resolveSession(store, 'aaaa');
    expect(result).toBeUndefined();
  });

  it('无任何匹配 → 返回 undefined', async () => {
    const store = mockStore([s1]);
    const result = await resolveSession(store, 'cccccccc');
    expect(result).toBeUndefined();
  });

  it('空会话列表 → 返回 undefined', async () => {
    const store = mockStore([]);
    const result = await resolveSession(store, 'aaaaaaaa');
    expect(result).toBeUndefined();
  });
});
