import { describe, expect, it } from 'vitest';

import { isValidCron, isValidTimezone, nextRunIso, parseCron } from '../../src/scheduler/cron.js';
import { safeReportPath } from '../../src/scheduler/deliver.js';

describe('cron engine', () => {
  it('computes daily 09:00 in a timezone', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(nextRunIso('0 9 * * *', 'Asia/Shanghai', from)).toBe('2026-01-01T01:00:00.000Z');
  });

  it('computes step expressions', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    expect(nextRunIso('*/15 * * * *', 'UTC', from)).toBe('2026-01-01T00:15:00.000Z');
  });

  it('computes weekly Monday in a timezone', () => {
    // 2026-01-01 是周四，下一个周一是 2026-01-05
    const from = new Date('2026-01-01T00:00:00Z');
    expect(nextRunIso('0 8 * * 1', 'Asia/Shanghai', from)).toBe('2026-01-05T00:00:00.000Z');
  });

  it('returns a strictly future time', () => {
    const at = new Date('2026-01-01T01:00:00Z');
    expect(nextRunIso('0 9 * * *', 'Asia/Shanghai', at)).toBe('2026-01-02T01:00:00.000Z');
  });

  it('supports day-of-month constraints', () => {
    const from = new Date('2026-01-15T00:00:00Z');
    expect(nextRunIso('0 0 1 * *', 'UTC', from)).toBe('2026-02-01T00:00:00.000Z');
  });

  it('validates expressions', () => {
    expect(isValidCron('0 9 * * *')).toBe(true);
    expect(isValidCron('*/5 0-23/2 1,15 * 1-5')).toBe(true);
    expect(isValidCron('bad')).toBe(false);
    expect(isValidCron('0 9 * *')).toBe(false);
    expect(isValidCron('0 9 * * * * *')).toBe(false);
    expect(isValidCron('60 9 * * *')).toBe(false);
  });

  it('validates timezones', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });

  it('rejects sub-minute seconds granularity', () => {
    expect(() => parseCron('30 * * * * *')).toThrow();
    expect(isValidCron('0 * * * * *')).toBe(true);
  });
});

describe('safeReportPath', () => {
  it('resolves inside the base directory', () => {
    expect(safeReportPath('/tmp/work', 'reports', 'a.md')).toBe('/tmp/work/reports/a.md');
  });

  it('rejects traversal outside the base directory', () => {
    expect(() => safeReportPath('/tmp/work', '../etc', 'a.md')).toThrow();
  });
});
