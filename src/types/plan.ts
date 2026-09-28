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
