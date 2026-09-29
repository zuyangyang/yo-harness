/**
 * 后台任务列表：展示任务状态 + 取消操作。
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type BackgroundTask } from '../../api/client.js';

const STATUS_COLORS: Record<string, string> = {
  pending: '#888',
  running: '#2196f3',
  completed: '#4caf50',
  failed: '#f44336',
  cancelled: '#ff9800',
};

export function TaskList(): JSX.Element {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.tasks.list();
      setTasks(res.tasks);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const handleCancel = useCallback(
    async (id: string) => {
      try {
        await api.tasks.cancel(id);
        await loadTasks();
      } catch {
        // ignore
      }
    },
    [loadTasks],
  );

  return (
    <div className="task-list">
      <h2>Background Tasks</h2>

      <button className="btn btn-primary" onClick={() => void loadTasks()}>
        Refresh
      </button>

      {isLoading ? (
        <p>Loading...</p>
      ) : tasks.length === 0 ? (
        <p>No tasks.</p>
      ) : (
        <table className="task-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Description</th>
              <th>Status</th>
              <th>Model</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td><code>{task.id.slice(0, 8)}</code></td>
                <td>{task.description}</td>
                <td>
                  <span
                    className="task-status"
                    style={{ color: STATUS_COLORS[task.status] ?? '#888' }}
                  >
                    {task.status}
                  </span>
                </td>
                <td>{task.model}</td>
                <td>{new Date(task.createdAt).toLocaleString()}</td>
                <td>
                  {(task.status === 'pending' || task.status === 'running') && (
                    <button className="btn btn-sm btn-danger" onClick={() => handleCancel(task.id)}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
