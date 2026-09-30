/**
 * 时间格式化工具。
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 把 ISO 时间转成「相对时间」文案（刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期）。 */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  const diff = now - then;

  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return Math.floor(diff / MINUTE) + ' 分钟前';
  if (diff < DAY) return Math.floor(diff / HOUR) + ' 小时前';
  if (diff < 7 * DAY) return Math.floor(diff / DAY) + ' 天前';
  return new Date(iso).toLocaleDateString();
}
