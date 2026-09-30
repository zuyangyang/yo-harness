import { useMemo } from 'react';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import type { Plan, PlanTask } from '@yo-harness/core/types/plan.js';
import { useSessionStore } from '../../stores/session.js';
import { PlanView } from '../../components/Plan/PlanView.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { ListBulletIcon } from '../../components/Icons/index.js';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

/** 把 plan_task_updated 事件合并回计划，实时推进任务状态。 */
function applyTaskUpdates(plan: Plan, events: EventEnvelope[]): Plan {
  const updates = new Map<string, TaskStatus>();
  for (const env of events) {
    if (env.payload.type === 'plan_task_updated') {
      updates.set(env.payload.taskId, env.payload.status);
    }
  }

  const apply = (task: PlanTask): PlanTask => {
    const status = updates.get(task.id) ?? task.status;
    return { ...task, status, children: task.children.map(apply) };
  };

  return { ...plan, tasks: plan.tasks.map(apply) };
}

export function PlanPanel(): JSX.Element {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const eventsMap = useSessionStore((s) => s.events);
  const events = currentSessionId ? (eventsMap.get(currentSessionId) ?? []) : [];

  const plan = useMemo(() => {
    let base: Plan | null = null;
    let baseIndex = -1;

    events.forEach((env, index) => {
      if (env.payload.type === 'plan_created') {
        base = env.payload.plan as Plan;
        baseIndex = index;
      }
    });

    if (!base) return null;
    return applyTaskUpdates(base, events.slice(baseIndex + 1));
  }, [events]);

  if (!plan) {
    return (
      <EmptyState
        icon={<ListBulletIcon className="icon-svg" />}
        title="暂无计划"
        description="当 Agent 以规划模式运行时，这里会展示执行计划与任务进度。"
      />
    );
  }

  return <PlanView plan={plan} />;
}
