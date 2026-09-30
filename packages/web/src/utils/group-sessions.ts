import type { Session } from '../api/client.js';

export interface SessionGroup {
  key: string;
  label: string;
  sessions: Session[];
}

const DAY = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 按 updatedAt 把会话分到 Today / Yesterday / Previous 7 days / Older 四组。 */
export function groupSessionsByTime(sessions: Session[], now = Date.now()): SessionGroup[] {
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY;
  const weekStart = todayStart - 6 * DAY;

  const groups: SessionGroup[] = [
    { key: 'today', label: 'Today', sessions: [] },
    { key: 'yesterday', label: 'Yesterday', sessions: [] },
    { key: 'week', label: 'Previous 7 days', sessions: [] },
    { key: 'older', label: 'Older', sessions: [] },
  ];

  for (const session of sessions) {
    const t = new Date(session.updatedAt).getTime();
    if (t >= todayStart) groups[0]!.sessions.push(session);
    else if (t >= yesterdayStart) groups[1]!.sessions.push(session);
    else if (t >= weekStart) groups[2]!.sessions.push(session);
    else groups[3]!.sessions.push(session);
  }

  return groups.filter((group) => group.sessions.length > 0);
}
