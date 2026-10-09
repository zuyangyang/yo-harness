/**
 * 定时任务页面：列表 + 新建/编辑 + 运行历史。
 */
import { useEffect, useState } from 'react';

import type { ScheduledTask } from '../../api/client.js';
import { useScheduleStore } from '../../stores/schedules.js';
import { ScheduleForm } from './ScheduleForm.js';
import { ScheduleRuns } from './ScheduleRuns.js';

export function SchedulesView(): JSX.Element {
  const schedules = useScheduleStore((s) => s.schedules);
  const isLoading = useScheduleStore((s) => s.isLoading);
  const error = useScheduleStore((s) => s.error);
  const load = useScheduleStore((s) => s.load);
  const create = useScheduleStore((s) => s.create);
  const update = useScheduleStore((s) => s.update);
  const remove = useScheduleStore((s) => s.remove);
  const toggle = useScheduleStore((s) => s.toggle);
  const runNow = useScheduleStore((s) => s.runNow);
  const clearError = useScheduleStore((s) => s.clearError);

  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const editingSchedule = editing !== null && editing !== 'new' ? editing : undefined;

  return (
    <div className="schedules-page">
      <div className="schedules-page__header">
        <div>
          <h2>定时任务</h2>
          <p className="schedules-page__hint">
            到点由服务端无头执行一轮 Agent，结果写入报告并生成站内通知。
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + 新建
        </button>
      </div>

      {error !== null ? (
        <div className="schedules-page__error" onClick={clearError}>
          {error}
        </div>
      ) : null}

      {editing !== null ? (
        <ScheduleForm
          {...(editingSchedule !== undefined ? { initial: editingSchedule } : {})}
          onSubmit={async (input) => {
            if (editingSchedule !== undefined) {
              await update(editingSchedule.id, input);
            } else {
              await create(input);
            }
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {isLoading ? (
        <p>加载中…</p>
      ) : schedules.length === 0 ? (
        <p className="schedules-page__empty">还没有定时任务，点击右上角新建一个。</p>
      ) : (
        <ul className="schedule-list">
          {schedules.map((schedule) => (
            <li key={schedule.id} className="schedule-card">
              <div className="schedule-card__main">
                <div className="schedule-card__title">
                  <strong>{schedule.name}</strong>
                  <span
                    className={
                      'schedule-card__badge' + (schedule.enabled ? ' schedule-card__badge--on' : '')
                    }
                  >
                    {schedule.enabled ? '已启用' : '已停用'}
                  </span>
                  {schedule.lastStatus !== null ? (
                    <span className="schedule-card__last">上次：{schedule.lastStatus}</span>
                  ) : null}
                </div>
                <div className="schedule-card__meta">
                  <code>{schedule.cron}</code> · {schedule.timezone} · 下次{' '}
                  {new Date(schedule.nextRunAt).toLocaleString()} · {schedule.outputKind}
                </div>
                <div className="schedule-card__prompt">{schedule.prompt}</div>
              </div>
              <div className="schedule-card__actions">
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => void toggle(schedule.id, !schedule.enabled)}
                >
                  {schedule.enabled ? '停用' : '启用'}
                </button>
                <button className="btn btn-sm btn-secondary" onClick={() => void runNow(schedule.id)}>
                  立即运行
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => setExpanded(expanded === schedule.id ? null : schedule.id)}
                >
                  {expanded === schedule.id ? '收起历史' : '运行历史'}
                </button>
                <button className="btn btn-sm btn-secondary" onClick={() => setEditing(schedule)}>
                  编辑
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    if (window.confirm('删除定时任务“' + schedule.name + '”？历史运行会保留。')) {
                      void remove(schedule.id);
                    }
                  }}
                >
                  删除
                </button>
              </div>
              {expanded === schedule.id ? (
                <div className="schedule-card__runs">
                  <ScheduleRuns scheduleId={schedule.id} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
