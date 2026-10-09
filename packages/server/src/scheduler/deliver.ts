/**
 * 运行结果投递：站内通知 + 报告落地 + WebSocket 广播。
 *
 * P0 只实现通知（表 + 广播）与 report（写 Markdown）；
 * webhook / 邮件等后续再补（见设计文档 §7.5）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { ScheduledTask } from '@yo-harness/core/core/ports.js';

import type { RunOutcome, SchedulerDeps } from './types.js';

function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, '-');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'report';
}

/** 解析报告路径，禁止逃出 baseDir（防路径穿越） */
export function safeReportPath(baseDir: string, target: string, fileName: string): string {
  const dir = resolve(baseDir, target);
  const rel = relative(baseDir, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('output target escapes workspace: ' + target);
  }
  return resolve(dir, fileName);
}

export async function deliver(
  deps: SchedulerDeps,
  schedule: ScheduledTask,
  cwd: string,
  outcome: RunOutcome,
): Promise<void> {
  const succeeded = outcome.status === 'completed';
  const title =
    '[' + schedule.name + '] ' + (succeeded ? '运行完成' : outcome.status === 'failed' ? '运行失败' : '运行取消');

  await deps.storage.notifications.create({
    sessionId: outcome.sessionId,
    kind: succeeded ? 'schedule_run' : 'schedule_failed',
    title,
    body: outcome.summary === null ? null : outcome.summary.slice(0, 500),
  });

  if (schedule.outputKind === 'report') {
    const fileName = new Date().toISOString().slice(0, 10) + '-' + sanitizeName(schedule.name) + '.md';
    const filePath = safeReportPath(cwd, schedule.outputTarget ?? 'reports', fileName);
    const body = '# ' + schedule.name + '\n\n' + (outcome.summary ?? '（本次运行没有文本输出）') + '\n';
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body, 'utf8');
  }

  deps.wsHub?.broadcastAll({
    type: 'task.completed',
    scheduleId: schedule.id,
    runId: outcome.runId,
    sessionId: outcome.sessionId,
    name: schedule.name,
    status: outcome.status,
    summary: outcome.summary,
  });
}
