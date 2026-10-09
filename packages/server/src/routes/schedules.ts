/**
 * 定时任务路由：CRUD / 立即运行 / 运行历史。
 */
import { Hono } from 'hono';

import type {
  ScheduleCatchUpPolicy,
  ScheduleOutputKind,
  ScheduleOverlapPolicy,
} from '@yo-harness/core/core/ports.js';

import type { ServerEnv } from '../types.js';
import { requirePermission } from '../auth/rbac.js';
import { isValidCron, isValidTimezone, nextRunIso } from '../scheduler/cron.js';
import type { ScheduledTaskScheduler } from '../scheduler/scheduler.js';

export interface ScheduleRouteDeps {
  scheduler: ScheduledTaskScheduler;
}

const OUTPUT_KINDS: ScheduleOutputKind[] = ['report', 'notification', 'webhook', 'none'];
const OVERLAP_POLICIES: ScheduleOverlapPolicy[] = ['skip', 'queue', 'allow'];
const CATCH_UP_POLICIES: ScheduleCatchUpPolicy[] = ['skip', 'run_once', 'grace'];

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function num(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function strArray(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return undefined;
}

interface ParsedFields {
  name?: string;
  prompt?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  workspaceId?: string | null;
  cwd?: string | null;
  model?: string | null;
  allowedTools?: string[] | null;
  maxSteps?: number | null;
  maxTokens?: number | null;
  maxDurationMs?: number | null;
  outputKind?: ScheduleOutputKind;
  outputTarget?: string | null;
  overlapPolicy?: ScheduleOverlapPolicy;
  catchUpPolicy?: ScheduleCatchUpPolicy;
}

type ParseResult = { ok: true; fields: ParsedFields } | { ok: false; error: string };

function parseFields(body: Record<string, unknown>, partial: boolean): ParseResult {
  const fields: ParsedFields = {};

  const name = str(body.name);
  const prompt = str(body.prompt);
  const cron = str(body.cron);
  if (!partial) {
    if (name === undefined || name.trim() === '') return { ok: false, error: 'name is required' };
    if (prompt === undefined || prompt.trim() === '') return { ok: false, error: 'prompt is required' };
    if (cron === undefined || cron.trim() === '') return { ok: false, error: 'cron is required' };
  }
  if (name !== undefined) fields.name = name;
  if (prompt !== undefined) fields.prompt = prompt;
  if (cron !== undefined) {
    if (!isValidCron(cron)) return { ok: false, error: 'invalid cron expression: ' + cron };
    fields.cron = cron;
  }

  const timezone = str(body.timezone);
  if (timezone !== undefined) {
    if (!isValidTimezone(timezone)) return { ok: false, error: 'invalid timezone: ' + timezone };
    fields.timezone = timezone;
  }

  const enabled = bool(body.enabled);
  if (enabled !== undefined) fields.enabled = enabled;

  if ('workspaceId' in body) fields.workspaceId = str(body.workspaceId) ?? null;
  if ('cwd' in body) fields.cwd = str(body.cwd) ?? null;
  if ('model' in body) fields.model = str(body.model) ?? null;

  const allowedTools = strArray(body.allowedTools);
  if (allowedTools !== undefined) fields.allowedTools = allowedTools;

  const maxSteps = num(body.maxSteps);
  if (maxSteps !== undefined) fields.maxSteps = maxSteps;
  const maxTokens = num(body.maxTokens);
  if (maxTokens !== undefined) fields.maxTokens = maxTokens;
  const maxDurationMs = num(body.maxDurationMs);
  if (maxDurationMs !== undefined) fields.maxDurationMs = maxDurationMs;

  const outputKind = str(body.outputKind);
  if (outputKind !== undefined) {
    if (!OUTPUT_KINDS.includes(outputKind as ScheduleOutputKind)) {
      return { ok: false, error: 'invalid outputKind' };
    }
    fields.outputKind = outputKind as ScheduleOutputKind;
  }
  if ('outputTarget' in body) {
    const target = str(body.outputTarget) ?? null;
    if (target !== null && target.includes('..')) {
      return { ok: false, error: 'outputTarget must not contain ..' };
    }
    fields.outputTarget = target;
  }

  const overlapPolicy = str(body.overlapPolicy);
  if (overlapPolicy !== undefined) {
    if (!OVERLAP_POLICIES.includes(overlapPolicy as ScheduleOverlapPolicy)) {
      return { ok: false, error: 'invalid overlapPolicy' };
    }
    fields.overlapPolicy = overlapPolicy as ScheduleOverlapPolicy;
  }
  const catchUpPolicy = str(body.catchUpPolicy);
  if (catchUpPolicy !== undefined) {
    if (!CATCH_UP_POLICIES.includes(catchUpPolicy as ScheduleCatchUpPolicy)) {
      return { ok: false, error: 'invalid catchUpPolicy' };
    }
    fields.catchUpPolicy = catchUpPolicy as ScheduleCatchUpPolicy;
  }

  return { ok: true, fields };
}

async function safeJson(c: { req: { json: <T>() => Promise<T> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json<unknown>();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createScheduleRoutes(deps: ScheduleRouteDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  app.use('*', requirePermission('schedules:read'));

  app.get('/', async (c) => {
    const store = c.get('storage');
    return c.json({ schedules: await store.scheduledTasks.list() });
  });

  app.post('/', requirePermission('schedules:write'), async (c) => {
    const body = await safeJson(c);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = parseFields(body, false);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const timezone = parsed.fields.timezone ?? 'UTC';
    const nextRunAt = nextRunIso(parsed.fields.cron ?? '', timezone);

    const store = c.get('storage');
    const schedule = await store.scheduledTasks.create({
      name: parsed.fields.name ?? '',
      prompt: parsed.fields.prompt ?? '',
      cron: parsed.fields.cron ?? '',
      timezone,
      nextRunAt,
      ...parsed.fields,
    });
    return c.json({ schedule }, 201);
  });

  app.get('/:id', async (c) => {
    const store = c.get('storage');
    const schedule = await store.scheduledTasks.get(c.req.param('id'));
    if (schedule === undefined) return c.json({ error: 'schedule not found' }, 404);
    return c.json({ schedule });
  });

  app.put('/:id', requirePermission('schedules:write'), async (c) => {
    const body = await safeJson(c);
    if (body === null) return c.json({ error: 'invalid JSON body' }, 400);

    const store = c.get('storage');
    const id = c.req.param('id');
    const existing = await store.scheduledTasks.get(id);
    if (existing === undefined) return c.json({ error: 'schedule not found' }, 404);

    const parsed = parseFields(body, true);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const schedule = await store.scheduledTasks.update(id, {
      ...parsed.fields,
      // cron / timezone 变更后重算下次运行时间
      ...(parsed.fields.cron !== undefined || parsed.fields.timezone !== undefined
        ? {
            nextRunAt: nextRunIso(
              parsed.fields.cron ?? existing.cron,
              parsed.fields.timezone ?? existing.timezone,
            ),
          }
        : {}),
    });
    return c.json({ schedule });
  });

  app.delete('/:id', requirePermission('schedules:write'), async (c) => {
    const store = c.get('storage');
    const id = c.req.param('id');
    const existing = await store.scheduledTasks.get(id);
    if (existing === undefined) return c.json({ error: 'schedule not found' }, 404);
    await store.scheduledTasks.delete(id);
    return c.json({ ok: true });
  });

  app.post('/:id/run', requirePermission('schedules:write'), async (c) => {
    const store = c.get('storage');
    const id = c.req.param('id');
    const existing = await store.scheduledTasks.get(id);
    if (existing === undefined) return c.json({ error: 'schedule not found' }, 404);

    // 立即运行不阻塞请求，也不影响 nextRunAt
    void deps.scheduler.runNow(id).catch(() => undefined);
    return c.json({ accepted: true });
  });

  app.get('/:id/runs', async (c) => {
    const store = c.get('storage');
    const id = c.req.param('id');
    const existing = await store.scheduledTasks.get(id);
    if (existing === undefined) return c.json({ error: 'schedule not found' }, 404);
    const limit = Number(c.req.query('limit') ?? '20');
    const runs = await store.tasks.list(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20, id);
    return c.json({ runs });
  });

  return app;
}
