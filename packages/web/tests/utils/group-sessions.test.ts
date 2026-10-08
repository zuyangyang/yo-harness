import { describe, expect, it } from 'vitest';

import type { Session } from '../../src/api/client.js';
import { groupSessionsByTime } from '../../src/utils/group-sessions.js';

const NOW = new Date('2025-06-15T12:00:00.000Z').getTime();
const DAY = 86_400_000;

function session(id: string, updatedAt: number): Session {
  const iso = new Date(updatedAt).toISOString();
  return {
    id,
    title: 'Session ' + id,
    model: 'test',
    cwd: '/',
    status: 'active',
    type: 'interactive',
    workspaceId: null,
    pinned: false,
    titleIsCustom: false,
    permissionMode: null,
    createdAt: iso,
    updatedAt: iso,
  };
}

describe('groupSessionsByTime', () => {
  it('groups sessions into time buckets', () => {
    const sessions = [
      session('today', NOW - 3_600_000),
      session('yesterday', NOW - 26 * 3_600_000),
      session('week', NOW - 4 * DAY),
      session('older', NOW - 20 * DAY),
    ];

    const groups = groupSessionsByTime(sessions, NOW);
    const keys = groups.map((g) => g.key);

    expect(keys).toEqual(['today', 'yesterday', 'week', 'older']);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(['today']);
    expect(groups[3]?.sessions.map((s) => s.id)).toEqual(['older']);
  });

  it('omits empty buckets', () => {
    const groups = groupSessionsByTime([session('today', NOW)], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('today');
  });

  it('returns empty array for no sessions', () => {
    expect(groupSessionsByTime([], NOW)).toEqual([]);
  });
});
