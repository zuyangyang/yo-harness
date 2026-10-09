/**
 * 计划数据模型 —— 规划器子代理的产出。
 *
 * Plan 是规划器探索代码库后生成的结构化执行计划，由用户确认后
 * 交给执行者按子任务推进。PlanOutputSchema 用于校验 LLM 的
 * JSON 输出（不含 id / createdAt，由 planner 层补充）。
 */
import { z } from 'zod';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

export interface PlanTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** 验收标准（自然语言列表） */
  acceptance: string[];
  /** 子任务（支持一层嵌套） */
  children: PlanTask[];
}

export interface Plan {
  id: string;
  /** 用户原始目标的精炼 */
  objective: string;
  tasks: PlanTask[];
  /** 全局验收标准 */
  verificationCriteria: string[];
  createdAt: string;
}

/** LLM 规划输出的 zod schema（不含 id / createdAt，由 planner 补充） */
export const PlanTaskOutputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  acceptance: z.array(z.string()),
  children: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      acceptance: z.array(z.string()),
    }),
  ),
});

export const PlanOutputSchema = z.object({
  objective: z.string().min(1),
  tasks: z.array(PlanTaskOutputSchema),
  verificationCriteria: z.array(z.string()),
});

export type PlanOutput = z.infer<typeof PlanOutputSchema>;

/** 任务状态图标（prompt 内展示用） */
function taskStatusIcon(status: TaskStatus): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '◐';
    case 'skipped':
      return '⊘';
    case 'pending':
    default:
      return '○';
  }
}

function formatTaskForPrompt(task: PlanTask, indent: number): string {
  const prefix = '  '.repeat(indent);
  let line = `${prefix}${task.id}. [${taskStatusIcon(task.status)}] ${task.title}`;
  if (task.acceptance.length > 0) {
    line += ` (acceptance: ${task.acceptance.join(', ')})`;
  }
  const lines = [line];
  for (const child of task.children) {
    lines.push(formatTaskForPrompt(child, indent + 1));
  }
  return lines.join('\n');
}

/** 把结构化计划格式化为注入 system prompt 的文本（§9.4） */
export function formatPlanForPrompt(plan: Plan): string {
  const lines: string[] = [
    '<execution-plan>',
    `Objective: ${plan.objective}`,
    '',
    'Tasks:',
  ];

  for (const task of plan.tasks) {
    lines.push(formatTaskForPrompt(task, 0));
  }

  if (plan.verificationCriteria.length > 0) {
    lines.push('');
    lines.push('Verification:');
    for (const criteria of plan.verificationCriteria) {
      lines.push(`- ${criteria}`);
    }
  }

  lines.push('');
  lines.push('Update task status by calling update_plan_task tool when you complete each task.');
  lines.push('</execution-plan>');

  return lines.join('\n');
}
