/**
 * 事件完整性校验脚本（step 9b）。
 *
 * 重放指定会话的全部事件，校验：
 * 1. seq 从 1 开始且单调递增（无跳号 / 重复）
 * 2. session_started 是第一条事件
 * 3. tool_call ↔ tool_result 以 callId 配对（无孤儿）
 * 4. turn_started ↔ turn_completed 以 turnId 配对
 * 5. approval_request ↔ approval_result 以 callId 配对
 *
 * 用法：
 *   npx tsx examples/replay-check.ts <session-id-or-prefix>
 *   npx tsx examples/replay-check.ts                 # 列最近 10 个会话
 *
 * 退出码：0 = 全部通过，1 = 有错误或无会话
 *
 * 注意：这是手动校验脚本，不进 CI、不进测试。
 */
import { join } from 'node:path';

import { openDatabase } from '@yo-harness/core/storage/db.js';
import { SqliteEventStore } from '@yo-harness/core/storage/event-store.js';
import { SqliteSessionStore } from '@yo-harness/core/storage/session-store.js';
import { yoHome } from '@yo-harness/core/utils/paths.js';
import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import type { Session } from '@yo-harness/core/core/ports.js';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function check(name: string, ok: boolean, detail: string): CheckResult {
  return { name, ok, detail };
}

function validate(events: EventEnvelope[]): CheckResult[] {
  const results: CheckResult[] = [];

  // 1. seq 单调递增，从 1 开始
  if (events.length === 0) {
    results.push(check('seq monotonic', false, 'no events'));
  } else {
    let ok = true;
    let detail = '';
    if (events[0]?.seq !== 1) {
      ok = false;
      detail = `first seq=${events[0]?.seq ?? 'undefined'}, expected 1`;
    } else {
      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const curr = events[i];
        if (curr === undefined || prev === undefined || curr.seq !== prev.seq + 1) {
          ok = false;
          detail = `gap at seq ${prev?.seq} → ${curr?.seq}`;
          break;
        }
      }
      if (ok) detail = `${events.length} events, seq 1..${events[events.length - 1]?.seq}`;
    }
    results.push(check('seq monotonic', ok, detail));
  }

  // 2. session_started 是第一条
  const first = events[0]?.payload;
  results.push(
    check(
      'session_started first',
      first?.type === 'session_started',
      first?.type === 'session_started'
        ? `model=${first.model} cwd=${first.cwd}`
        : `first event type=${first?.type ?? 'none'}`,
    ),
  );

  // 3. tool_call ↔ tool_result 配对
  const toolCalls = new Map<string, string>(); // callId → toolName
  const toolResults = new Set<string>();
  for (const env of events) {
    const p = env.payload;
    if (p.type === 'tool_call') toolCalls.set(p.callId, p.toolName);
    if (p.type === 'tool_result') toolResults.add(p.callId);
  }
  const orphanCalls = [...toolCalls.keys()].filter((id) => !toolResults.has(id));
  const orphanResults = [...toolResults].filter((id) => !toolCalls.has(id));
  results.push(
    check(
      'tool_call ↔ tool_result',
      orphanCalls.length === 0 && orphanResults.length === 0,
      `${toolCalls.size} calls, ${toolResults.size} results` +
        (orphanCalls.length > 0 ? `, orphan calls: ${orphanCalls.join(', ')}` : '') +
        (orphanResults.length > 0 ? `, orphan results: ${orphanResults.join(', ')}` : ''),
    ),
  );

  // 4. turn_started ↔ turn_completed 配对
  const turnStarts = new Set<string>();
  const turnEnds = new Map<string, string>(); // turnId → reason
  for (const env of events) {
    const p = env.payload;
    if (p.type === 'turn_started') turnStarts.add(p.turnId);
    if (p.type === 'turn_completed') turnEnds.set(p.turnId, p.reason);
  }
  const orphanStarts = [...turnStarts].filter((id) => !turnEnds.has(id));
  const orphanEnds = [...turnEnds.keys()].filter((id) => !turnStarts.has(id));
  results.push(
    check(
      'turn_started ↔ turn_completed',
      orphanStarts.length === 0 && orphanEnds.length === 0,
      `${turnStarts.size} turns` +
        (orphanStarts.length > 0 ? `, missing completion: ${orphanStarts.join(', ')}` : '') +
        (orphanEnds.length > 0 ? `, missing start: ${orphanEnds.join(', ')}` : ''),
    ),
  );

  // 5. approval_request ↔ approval_result 配对
  const approvalReqs = new Set<string>();
  const approvalResps = new Set<string>();
  for (const env of events) {
    const p = env.payload;
    if (p.type === 'approval_request') approvalReqs.add(p.callId);
    if (p.type === 'approval_result') approvalResps.add(p.callId);
  }
  const orphanReqs = [...approvalReqs].filter((id) => !approvalResps.has(id));
  const orphanResps = [...approvalResps].filter((id) => !approvalReqs.has(id));
  results.push(
    check(
      'approval_request ↔ approval_result',
      orphanReqs.length === 0 && orphanResps.length === 0,
      `${approvalReqs.size} requests, ${approvalResps.size} responses` +
        (orphanReqs.length > 0 ? `, orphan requests: ${orphanReqs.join(', ')}` : '') +
        (orphanResps.length > 0 ? `, orphan responses: ${orphanResps.join(', ')}` : ''),
    ),
  );

  // 6. plan_created ↔ plan_approved/plan_rejected 配对
  const plansCreated = new Set<string>();
  const plansApproved = new Set<string>();
  const plansRejected = new Set<string>();
  for (const env of events) {
    const p = env.payload;
    if (p.type === 'plan_created') plansCreated.add((p.plan as { id: string }).id);
    if (p.type === 'plan_approved') plansApproved.add(p.planId);
    if (p.type === 'plan_rejected') plansRejected.add(p.planId);
  }
  const plansPending = [...plansCreated].filter(
    (id) => !plansApproved.has(id) && !plansRejected.has(id),
  );
  const plansWithoutCreate = [...plansApproved, ...plansRejected].filter(
    (id) => !plansCreated.has(id),
  );
  results.push(
    check(
      'plan_created ↔ approved/rejected',
      plansPending.length === 0 && plansWithoutCreate.length === 0,
      `${plansCreated.size} plans created, ${plansApproved.size} approved, ${plansRejected.size} rejected` +
        (plansPending.length > 0 ? `, pending: ${plansPending.join(', ')}` : '') +
        (plansWithoutCreate.length > 0 ? `, missing create: ${plansWithoutCreate.join(', ')}` : ''),
    ),
  );

  // 7. Phase 2 事件统计
  const phase2Events = ['context_compressed', 'checkpoint_created', 'checkpoint_restored', 'goal_reminder'];
  const phase2Counts = phase2Events.map((type) => {
    const count = events.filter((e) => e.payload.type === type).length;
    return count > 0 ? `${type}:${count}` : null;
  }).filter((s): s is string => s !== null);
  if (phase2Counts.length > 0) {
    results.push(check('Phase 2 events', true, phase2Counts.join(' ')));
  }

  // 7b. Phase 3 事件统计
  const phase3Events = ['memory_extracted', 'memory_injected', 'task_started', 'task_completed', 'task_failed'];
  const phase3Counts = phase3Events.map((type) => {
    const count = events.filter((e) => e.payload.type === type).length;
    return count > 0 ? `${type}:${count}` : null;
  }).filter((s): s is string => s !== null);
  if (phase3Counts.length > 0) {
    results.push(check('Phase 3 events', true, phase3Counts.join(' ')));
  }

  // 8. 事件类型分布统计
  const typeCounts = new Map<string, number>();
  for (const env of events) {
    const type = env.payload.type;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  const dist = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}:${count}`)
    .join(' ');
  results.push(check('event distribution', true, dist));

  return results;
}

async function resolveSession(
  sessionStore: SqliteSessionStore,
  idOrPrefix: string,
): Promise<Session | undefined> {
  const exact = await sessionStore.get(idOrPrefix);
  if (exact !== undefined) return exact;
  if (idOrPrefix.length < 8) return undefined;
  const recent = await sessionStore.listRecent(100);
  const matches = recent.filter((s) => s.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  return undefined;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const db = openDatabase(join(yoHome(), 'sessions.db'));
  try {
    const sessionStore = new SqliteSessionStore(db);
    const eventStore = new SqliteEventStore(db);

    // 无参数：列最近 10 个会话
    if (arg === undefined) {
      const sessions = await sessionStore.listRecent(10);
      if (sessions.length === 0) {
        process.stdout.write('no sessions found.\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write('recent sessions:\n');
      for (const s of sessions) {
        const title = s.title.length > 0 ? s.title : '(untitled)';
        process.stdout.write(`  ${s.id.slice(0, 8)}  ${s.updatedAt.slice(0, 16).replace('T', ' ')}  ${s.model}  ${title}\n`);
      }
      process.stdout.write('\nrun: npx tsx examples/replay-check.ts <id>\n');
      return;
    }

    // 有参数：解析并校验
    const session = await resolveSession(sessionStore, arg);
    if (session === undefined) {
      process.stderr.write(`session not found: "${arg}"\n`);
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`session ${session.id.slice(0, 8)} — ${session.model} — ${session.title || '(untitled)'}\n`);

    const envelopes = await eventStore.replay(session.id);
    const results = validate(envelopes);

    let allOk = true;
    for (const r of results) {
      const marker = r.ok ? '✓' : '✗';
      process.stdout.write(`  ${marker} ${r.name}: ${r.detail}\n`);
      if (!r.ok) allOk = false;
    }

    process.stdout.write(`\n${allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}\n`);
    process.exitCode = allOk ? 0 : 1;
  } finally {
    db.close();
  }
}

void main();
