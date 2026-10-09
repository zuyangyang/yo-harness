/**
 * 定时任务调度器：周期性扫描到期任务并触发无头运行。
 *
 * - nextRunAt 在触发前先写回，避免下一 tick 重复触发；
 * - 单进程内用 running 集合做重叠与并发守卫；
 * - 进程重启时 recover() 补齐错过周期并清理僵尸运行。
 */
import type { ScheduledTask } from '@yo-harness/core/core/ports.js';

import { nextRunIso } from './cron.js';
import { deliver } from './deliver.js';
import { runSchedule } from './runner.js';
import type { SchedulerDeps } from './types.js';

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_FAILURES = 5;
const GRACE_WINDOW_MS = 60 * 60 * 1000;

export class ScheduledTaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Set<string>();
  private ticking = false;
  private started = false;

  constructor(private readonly deps: SchedulerDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.recover();
    const tickMs = this.deps.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    this.timer.unref();
    this.deps.logger.info('scheduler started', { tickMs });
  }

  stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
    return Promise.resolve();
  }

  get inFlightCount(): number {
    return this.running.size;
  }

  /** 立即运行一次（不影响 nextRunAt） */
  async runNow(id: string): Promise<void> {
    const schedule = await this.deps.storage.scheduledTasks.get(id);
    if (schedule === undefined) throw new Error('schedule not found: ' + id);
    await this.dispatch(schedule);
  }

  private async recover(): Promise<void> {
    const schedules = await this.deps.storage.scheduledTasks.list();
    const now = Date.now();
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      const dueAt = new Date(schedule.nextRunAt).getTime();
      if (!Number.isFinite(dueAt) || dueAt > now) continue;

      await this.deps.storage.scheduledTasks.update(schedule.id, { nextRunAt: this.computeNext(schedule) });

      const withinGrace = now - dueAt <= GRACE_WINDOW_MS;
      const catchUp =
        schedule.catchUpPolicy === 'run_once' || (schedule.catchUpPolicy === 'grace' && withinGrace);
      if (catchUp) {
        void this.dispatch(schedule).catch((err: unknown) => {
          this.deps.logger.error('scheduled catch-up run failed', {
            scheduleId: schedule.id,
            error: String(err),
          });
        });
      }
    }
    await this.cleanupZombieRuns();
  }

  private computeNext(schedule: ScheduledTask): string {
    return nextRunIso(schedule.cron, schedule.timezone, new Date());
  }

  /** 上次进程退出时仍在 running/pending 的定时运行，标记为失败 */
  private async cleanupZombieRuns(): Promise<void> {
    const tasks = await this.deps.storage.tasks.list(100);
    for (const task of tasks) {
      if (task.trigger !== 'schedule') continue;
      if (task.status !== 'running' && task.status !== 'pending') continue;
      await this.deps.storage.tasks.updateStatus(task.id, 'failed', 'error', 'server restarted');
      this.deps.logger.warn('marked stale scheduled run as failed', { taskId: task.id });
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.deps.storage.scheduledTasks.listDue(new Date().toISOString());
      const maxConcurrent = this.deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT;
      for (const schedule of due) {
        if (this.running.size >= maxConcurrent) break;
        await this.deps.storage.scheduledTasks.update(schedule.id, {
          nextRunAt: this.computeNext(schedule),
        });
        if (schedule.overlapPolicy === 'skip' && this.running.has(schedule.id)) {
          this.deps.logger.warn('scheduled run skipped (previous run still active)', {
            scheduleId: schedule.id,
          });
          continue;
        }
        void this.dispatch(schedule).catch((err: unknown) => {
          this.deps.logger.error('scheduled run failed', {
            scheduleId: schedule.id,
            error: String(err),
          });
        });
      }
    } catch (err) {
      this.deps.logger.error('scheduler tick failed', { error: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  private async dispatch(schedule: ScheduledTask): Promise<void> {
    if (this.running.has(schedule.id) && schedule.overlapPolicy === 'skip') return;
    this.running.add(schedule.id);
    try {
      const cwd = schedule.cwd ?? this.deps.defaultCwd;
      const outcome = await runSchedule(this.deps, schedule);
      try {
        await deliver(this.deps, schedule, cwd, outcome);
      } catch (err) {
        this.deps.logger.error('scheduled delivery failed', {
          scheduleId: schedule.id,
          error: String(err),
        });
      }

      const maxFailures = this.deps.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
      const failures = outcome.status === 'failed' ? schedule.consecutiveFailures + 1 : 0;
      const disabled = maxFailures > 0 && failures >= maxFailures;
      await this.deps.storage.scheduledTasks.update(schedule.id, {
        lastRunAt: new Date().toISOString(),
        lastRunId: outcome.runId,
        lastStatus: outcome.status,
        consecutiveFailures: failures,
        ...(disabled ? { enabled: false } : {}),
      });
      if (disabled) {
        this.deps.logger.error('schedule disabled after repeated failures', {
          scheduleId: schedule.id,
          failures,
        });
      }
    } finally {
      this.running.delete(schedule.id);
    }
  }
}
