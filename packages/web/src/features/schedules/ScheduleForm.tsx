/**
 * 定时任务创建 / 编辑表单。
 *
 * 频率用「每天 / 每周 / 每月 / 自定义」预设生成 cron，避免用户直接写表达式。
 */
import { useState, type FormEvent } from 'react';

import type { ScheduleInput, ScheduleOutputKind, ScheduledTask } from '../../api/client.js';

type Preset = 'daily' | 'weekly' | 'monthly' | 'custom';

const TIMEZONES = [
  'Asia/Shanghai',
  'UTC',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
];

function defaultTime(): string {
  const now = new Date();
  return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
}

function buildCron(preset: Preset, time: string, custom: string): string {
  if (preset === 'custom') return custom.trim();
  const [h, m] = time.split(':').map((v) => Number(v));
  const minute = Number.isFinite(m) ? m : 0;
  const hour = Number.isFinite(h) ? h : 9;
  if (preset === 'daily') return String(minute) + ' ' + String(hour) + ' * * *';
  if (preset === 'weekly') return String(minute) + ' ' + String(hour) + ' * * 1';
  return String(minute) + ' ' + String(hour) + ' 1 * *';
}

interface Props {
  initial?: ScheduledTask;
  onSubmit: (input: ScheduleInput) => Promise<void>;
  onCancel: () => void;
}

export function ScheduleForm({ initial, onSubmit, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [preset, setPreset] = useState<Preset>(initial ? 'custom' : 'daily');
  const [time, setTime] = useState(defaultTime());
  const [customCron, setCustomCron] = useState(initial?.cron ?? '0 9 * * *');
  const [timezone, setTimezone] = useState(
    initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );
  const [outputKind, setOutputKind] = useState<ScheduleOutputKind>(initial?.outputKind ?? 'report');
  const [outputTarget, setOutputTarget] = useState(initial?.outputTarget ?? 'reports');
  const [allowedTools, setAllowedTools] = useState(
    (initial?.allowedTools ?? ['web_search', 'web_fetch', 'write_file', 'read_file']).join(', '),
  );
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        prompt: prompt.trim(),
        cron: buildCron(preset, time, customCron),
        timezone,
        outputKind,
        outputTarget: outputTarget.trim() === '' ? null : outputTarget.trim(),
        allowedTools: allowedTools
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        overlapPolicy: initial?.overlapPolicy ?? 'skip',
        catchUpPolicy: initial?.catchUpPolicy ?? 'skip',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="schedule-form" onSubmit={(e) => void handleSubmit(e)}>
      <h3>{initial ? '编辑定时任务' : '新建定时任务'}</h3>

      <label className="schedule-form__label">名称</label>
      <input
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="每日行业调研"
        required
      />

      <label className="schedule-form__label">任务指令（Prompt）</label>
      <textarea
        className="input"
        rows={4}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="调研 AI Agent 领域今日重要进展，按【要闻/融资/产品/论文】四节输出 Markdown 报告，每条附来源链接。"
        required
      />

      <div className="schedule-form__row">
        <div>
          <label className="schedule-form__label">频率</label>
          <select
            className="select"
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
          >
            <option value="daily">每天</option>
            <option value="weekly">每周一</option>
            <option value="monthly">每月 1 日</option>
            <option value="custom">自定义 cron</option>
          </select>
        </div>
        {preset !== 'custom' ? (
          <div>
            <label className="schedule-form__label">时间</label>
            <input
              className="input"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <label className="schedule-form__label">cron 表达式</label>
            <input
              className="input"
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
              placeholder="0 9 * * *"
            />
          </div>
        )}
        <div>
          <label className="schedule-form__label">时区</label>
          <select className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="schedule-form__row">
        <div>
          <label className="schedule-form__label">输出方式</label>
          <select
            className="select"
            value={outputKind}
            onChange={(e) => setOutputKind(e.target.value as ScheduleOutputKind)}
          >
            <option value="report">写入报告文件 + 通知</option>
            <option value="notification">仅站内通知</option>
            <option value="none">不投递</option>
          </select>
        </div>
        <div>
          <label className="schedule-form__label">报告目录（相对工作区）</label>
          <input
            className="input"
            value={outputTarget}
            onChange={(e) => setOutputTarget(e.target.value)}
            placeholder="reports"
          />
        </div>
      </div>

      <label className="schedule-form__label">允许的工具（逗号分隔）</label>
      <input
        className="input"
        value={allowedTools}
        onChange={(e) => setAllowedTools(e.target.value)}
        placeholder="web_search, web_fetch, write_file, read_file"
      />

      <div className="schedule-form__actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? '保存中…' : initial ? '保存' : '创建'}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
