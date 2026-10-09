/**
 * 单次定时运行：建 background 会话 → 无头跑一轮 → 写回运行历史。
 *
 * 复用 SessionManager 的 AgentLoop，因此运行事件照常经 wsHub 广播，
 * 用户打开该会话即可实时/事后查看完整过程。
 */
import type { TurnEndReason } from '@yo-harness/core/types/events.js';

import type { SchedulerDeps, RunOutcome, RunStatus } from './types.js';
import type { ScheduledTask } from '@yo-harness/core/core/ports.js';

function statusForReason(reason: TurnEndReason): RunStatus {
  if (reason === 'done') return 'completed';
  if (reason === 'error') return 'failed';
  if (reason === 'interrupted') return 'cancelled';
  // max_steps / budget：按完成处理，摘要仍然可用
  return 'completed';
}

function endReasonFor(reason: TurnEndReason): 'end_turn' | 'budget' | 'error' | 'cancelled' {
  if (reason === 'done') return 'end_turn';
  if (reason === 'error') return 'error';
  if (reason === 'interrupted') return 'cancelled';
  return 'budget';
}

async function lastAssistantText(deps: SchedulerDeps, sessionId: string): Promise<string | null> {
  const envelopes = await deps.storage.events.replay(sessionId);
  for (let i = envelopes.length - 1; i >= 0; i -= 1) {
    const payload = envelopes[i]?.payload;
    if (payload?.type === 'assistant_text') {
      return payload.text.slice(0, 2000);
    }
  }
  return null;
}

export async function runSchedule(
  deps: SchedulerDeps,
  schedule: ScheduledTask,
): Promise<RunOutcome> {
  const cwd = schedule.cwd ?? deps.defaultCwd;
  const model = schedule.model ?? deps.defaultModelLabel();
  const dateLabel = new Date().toISOString().slice(0, 10);

  // 1) 先建会话：background + full 权限，无人审批也不会阻塞
  const session = await deps.storage.sessions.create({
    model,
    cwd,
    title: '[定时] ' + schedule.name + ' · ' + dateLabel,
    titleIsCustom: true,
    workspaceId: schedule.workspaceId ?? null,
    type: 'background',
    permissionMode: 'full',
  });

  // 2) 运行历史行（复用 tasks 表）
  const run = await deps.storage.tasks.create({
    description: schedule.name,
    cwd,
    model,
    sessionId: session.id,
    scheduleId: schedule.id,
    trigger: 'schedule',
  });

  await deps.storage.tasks.updateStatus(run.id, 'running');

  // 3) 无头执行并等待
  let reason: TurnEndReason;
  try {
    reason = await deps.sessionManager.sendMessageAndWait(session.id, schedule.prompt);
  } catch (err) {
    const message = String(err);
    deps.logger.error('scheduled run failed to start', { scheduleId: schedule.id, error: message });
    await deps.storage.tasks.updateStatus(run.id, 'failed', 'error', message);
    return { runId: run.id, sessionId: session.id, status: 'failed', summary: null, reason: 'error' };
  }

  const summary = await lastAssistantText(deps, session.id);
  const status = statusForReason(reason);
  await deps.storage.tasks.updateStatus(
    run.id,
    status,
    endReasonFor(reason),
    status === 'failed' ? (summary ?? 'run failed') : undefined,
    summary ?? undefined,
  );

  return { runId: run.id, sessionId: session.id, status, summary, reason };
}
