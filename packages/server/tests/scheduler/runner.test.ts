import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Logger } from '@yo-harness/core/types/common.js';

import { createSqliteBackend } from '../../src/storage/sqlite.js';
import type { StorageBackend } from '../../src/storage/interface.js';
import type { SessionManager } from '../../src/session-manager.js';
import { ScheduledTaskScheduler } from '../../src/scheduler/scheduler.js';
import type { SchedulerDeps } from '../../src/scheduler/types.js';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/** 假 SessionManager：写入一段 assistant_text 并返回 done，避免真实 LLM。 */
function fakeSessionManager(storage: StorageBackend): SessionManager {
  return {
    sendMessageAndWait: async (sessionId: string) => {
      await storage.events.append(sessionId, {
        type: 'assistant_text',
        text: '调研报告正文',
        toolCalls: [],
      });
      return 'done';
    },
  } as unknown as SessionManager;
}

async function makeDeps(): Promise<{ deps: SchedulerDeps; backend: StorageBackend; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'yo-sched-'));
  const backend = createSqliteBackend(join(dir, 'test.db'));
  await backend.initialize();
  const deps: SchedulerDeps = {
    storage: backend,
    sessionManager: fakeSessionManager(backend),
    logger,
    defaultCwd: dir,
    resolveDefaultModel: async () => 'fake/model',
  };
  return { deps, backend, dir };
}

describe('ScheduledTaskScheduler', () => {
  it('runNow executes a schedule and records run, notification and report', async () => {
    const { deps, backend, dir } = await makeDeps();

    const schedule = await backend.scheduledTasks.create({
      name: '每日调研',
      prompt: '调研 AI Agent 领域进展',
      cron: '0 9 * * *',
      timezone: 'UTC',
      nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
      outputKind: 'report',
      outputTarget: 'reports',
    });

    const scheduler = new ScheduledTaskScheduler(deps);
    await scheduler.runNow(schedule.id);

    const runs = await backend.tasks.list(10, schedule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.trigger).toBe('schedule');
    expect(runs[0]?.summary).toContain('调研报告正文');

    expect(await backend.notifications.countUnread()).toBe(1);

    const reports = readdirSync(join(dir, 'reports'));
    expect(reports.some((name) => name.endsWith('.md'))).toBe(true);

    await backend.close();
  });

  it('lists due schedules and leaves future ones out', async () => {
    const { deps, backend } = await makeDeps();

    const due = await backend.scheduledTasks.create({
      name: '已到期',
      prompt: 'p',
      cron: '* * * * *',
      timezone: 'UTC',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await backend.scheduledTasks.create({
      name: '未到期',
      prompt: 'p',
      cron: '* * * * *',
      timezone: 'UTC',
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const list = await backend.scheduledTasks.listDue(new Date().toISOString());
    expect(list.map((s) => s.id)).toEqual([due.id]);

    void deps;
    await backend.close();
  });
});
