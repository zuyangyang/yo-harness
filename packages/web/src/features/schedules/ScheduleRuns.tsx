/**
 * 定时任务运行历史。
 */
import { useEffect, useState } from 'react';

import { api, type BackgroundTask } from '../../api/client.js';

const STATUS_COLORS: Record<string, string> = {
  pending: '#888',
  running: '#2196f3',
  completed: '#4caf50',
  failed: '#f44336',
  cancelled: '#ff9800',
};

export function ScheduleRuns({ scheduleId }: { scheduleId: string }): JSX.Element {
  const [runs, setRuns] = useState<BackgroundTask[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void api.schedules
      .runs(scheduleId)
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleId]);

  if (isLoading) return <p className="schedule-runs__empty">加载运行历史…</p>;
  if (runs.length === 0) return <p className="schedule-runs__empty">还没有运行记录。</p>;

  return (
    <table className="task-table">
      <thead>
        <tr>
          <th>状态</th>
          <th>开始时间</th>
          <th>摘要</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>
              <span className="task-status" style={{ color: STATUS_COLORS[run.status] ?? '#888' }}>
                {run.status}
              </span>
            </td>
            <td>{new Date(run.createdAt).toLocaleString()}</td>
            <td>{run.summary ?? run.errorMessage ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
