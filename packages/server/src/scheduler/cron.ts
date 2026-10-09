/**
 * 最小 cron 引擎（无外部依赖）。
 *
 * 支持：
 * - 5 段：minute hour day-of-month month day-of-week
 * - 6 段：second minute hour dom month dow（秒段仅接受 0 或 *，最小调度粒度 1 分钟）
 *
 * 字段语法：通配符、单值、a-b、a,b,c、通配符/n、a-b/n。
 * 时区使用 IANA 名称，通过 Intl 换算本地日历字段，因此能正确处理 DST。
 * day-of-month 与 day-of-week 同时受限时按 vixie-cron 语义取「或」。
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  values: Set<number>;
  restricted: boolean;
}

function parseField(spec: string, min: number, max: number, normalize?: (n: number) => number): FieldSpec {
  const trimmed = spec.trim();
  if (trimmed === '') throw new Error('empty cron field');

  const values = new Set<number>();
  const restricted = trimmed !== '*';

  for (const token of trimmed.split(',')) {
    const part = token.trim();
    if (part === '') throw new Error('empty cron token: ' + spec);

    let base = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      base = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      step = Number(stepText);
      if (!Number.isInteger(step) || step <= 0) throw new Error('invalid cron step: ' + part);
    }

    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = min;
      hi = max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-');
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error('invalid cron range: ' + part);
    } else {
      const single = Number(base);
      if (!Number.isInteger(single)) throw new Error('invalid cron value: ' + part);
      lo = single;
      hi = single;
    }

    if (lo < min || hi > max || lo > hi) throw new Error('cron field out of range: ' + part);
    for (let n = lo; n <= hi; n += step) {
      values.add(normalize ? normalize(n) : n);
    }
  }

  return { values, restricted };
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error('cron expression must have 5 or 6 fields: ' + expression);
  }

  let offset = 0;
  if (fields.length === 6) {
    const second = (fields[0] ?? '').trim();
    if (second !== '0' && second !== '*') {
      throw new Error('seconds granularity is not supported (use 0 or *): ' + expression);
    }
    offset = 1;
  }

  const minute = parseField(fields[offset] ?? '', 0, 59);
  const hour = parseField(fields[offset + 1] ?? '', 0, 23);
  const dom = parseField(fields[offset + 2] ?? '', 1, 31);
  const month = parseField(fields[offset + 3] ?? '', 1, 12);
  const dowRaw = fields[offset + 4] ?? '';
  const dow = parseField(dowRaw, 0, 7, (n) => (n === 7 ? 0 : n));

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localParts(date: Date, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayName = get('weekday');
  const weekday = WEEKDAYS.indexOf(weekdayName);
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    day: Number(get('day')),
    month: Number(get('month')),
    weekday: weekday < 0 ? 0 : weekday,
  };
}

function matches(cron: ParsedCron, p: LocalParts): boolean {
  if (!cron.minutes.has(p.minute)) return false;
  if (!cron.hours.has(p.hour)) return false;
  if (!cron.months.has(p.month)) return false;

  const domMatch = cron.daysOfMonth.has(p.day);
  const dowMatch = cron.daysOfWeek.has(p.weekday);
  if (cron.domRestricted && cron.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

const MAX_LOOKAHEAD_MINUTES = 366 * 24 * 60;

/**
 * 计算严格晚于 from 的下一次触发时间（UTC Date）。
 */
export function nextRun(cron: ParsedCron, timezone: string, from: Date): Date {
  let cursorMs = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i += 1) {
    const cursor = new Date(cursorMs);
    if (matches(cron, localParts(cursor, timezone))) return cursor;
    cursorMs += 60000;
  }
  throw new Error('no matching time found within one year');
}

/** 便捷函数：解析表达式并计算下次触发时间（ISO 字符串） */
export function nextRunIso(expression: string, timezone: string, from: Date = new Date()): string {
  const cron = parseCron(expression);
  if (!isValidTimezone(timezone)) throw new Error('invalid timezone: ' + timezone);
  return nextRun(cron, timezone, from).toISOString();
}
