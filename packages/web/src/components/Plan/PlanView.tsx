/**
 * 计划展示：从事件流中提取 plan_created/plan_updated 事件，渲染任务树 + 进度。
 *
 * Plan 数据来自 AgentEvent payload（plan 类型事件），只读展示。
 */
import {
  CircleEmptyIcon,
  CircleHalfIcon,
  CircleFilledIcon,
  CircleDashedIcon,
} from '../Icons/index.js';

interface PlanTask {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  acceptance: string[];
  children: PlanTask[];
}

interface Plan {
  id: string;
  objective: string;
  tasks: PlanTask[];
  verificationCriteria: string[];
  createdAt: string;
}

interface PlanViewProps {
  plan: Plan;
}

const STATUS_ICON: Record<string, JSX.Element> = {
  pending: <CircleEmptyIcon className="icon-plan-status" />,
  in_progress: <CircleHalfIcon className="icon-plan-status" />,
  completed: <CircleFilledIcon className="icon-plan-status" />,
  skipped: <CircleDashedIcon className="icon-plan-status" />,
};

function computeProgress(tasks: PlanTask[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    total++;
    if (t.status === 'completed' || t.status === 'skipped') done++;
    const child = computeProgress(t.children);
    done += child.done;
    total += child.total;
  }
  return { done, total };
}

function TaskTreeNode({ task }: { task: PlanTask }): JSX.Element {
  return (
    <li className={`plan-task plan-task--${task.status}`}>
      <span className="plan-task-icon">{STATUS_ICON[task.status]}</span>
      <span className="plan-task-title">{task.title}</span>
      {task.children.length > 0 && (
        <ul className="plan-task-children">
          {task.children.map((child) => (
            <TaskTreeNode key={child.id} task={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function PlanView({ plan }: PlanViewProps): JSX.Element {
  const { done, total } = computeProgress(plan.tasks);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="plan-view">
      <h3 className="plan-objective">{plan.objective}</h3>

      <div className="plan-progress">
        <div className="plan-progress-bar">
          <div className="plan-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="plan-progress-text">
          {done}/{total} tasks ({percent}%)
        </span>
      </div>

      <ul className="plan-task-tree">
        {plan.tasks.map((task) => (
          <TaskTreeNode key={task.id} task={task} />
        ))}
      </ul>

      {plan.verificationCriteria.length > 0 && (
        <div className="plan-verification">
          <h4>Verification Criteria</h4>
          <ul>
            {plan.verificationCriteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
