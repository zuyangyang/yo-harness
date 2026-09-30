import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from '../../src/utils/time.js';

const NOW = new Date('2025-06-15T12:00:00.000Z').getTime();

describe('formatRelativeTime', () => {
  it('returns 刚刚 for under a minute', () => {
    expect(formatRelativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('刚刚');
  });

  it('returns minutes', () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 分钟前');
  });

  it('returns hours', () => {
    expect(formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3 小时前');
  });

  it('returns days', () => {
    expect(formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2 天前');
  });

  it('falls back to a locale date beyond a week', () => {
    const result = formatRelativeTime(new Date(NOW - 10 * 86_400_000).toISOString(), NOW);
    expect(result).not.toContain('前');
  });
});
