/**
 * 计划展示与审批 UI（§6.8）。
 *
 * 收到 plan_created 事件后渲染计划详情，等待用户审批：
 * - y：批准计划
 * - e：编辑模式（Phase 2 简化版：逐个任务确认/跳过）
 * - n：拒绝计划
 *
 * 设计约束：
 * - 纯 ink 组件，不依赖外部状态管理
 * - 通过 AskBridge 模式与 agent-loop 通信
 * - 编辑模式 Phase 2 简化：只支持跳过/恢复任务，不支持改标题
 */
import { Box, Text, useInput, type ReactElement } from 'react';

import type { Plan, PlanTask } from '../types/plan.js';

export type PlanApproval = 'approved' | 'rejected';

export interface PlanApprovalProps {
  plan: Plan;
  onApprove: () => void;
  onReject: (reason: string) => void;
}

/** 任务状态图标 */
function taskStatusIcon(status: string): string {
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

/** 渲染单个任务 */
function renderTask(task: PlanTask, indent: number): ReactElement[] {
  const elements: ReactElement[] = [];
  const prefix = '  '.repeat(indent);
  const icon = taskStatusIcon(task.status);

  elements.push(
    <Text key={`${task.id}-title`}>
      {prefix}
      {icon} {task.id}. {task.title}
    </Text>,
  );

  // 渲染子任务
  for (const child of task.children) {
    elements.push(...renderTask(child, indent + 1));
  }

  return elements;
}

/** 计划展示组件 */
export function PlanDisplay({ plan }: { plan: Plan }): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        📋 Execution Plan
      </Text>
      <Text> </Text>
      <Text dimColor>Objective: {plan.objective}</Text>
      <Text> </Text>
      {plan.tasks.map((task) => renderTask(task, 0))}
      {plan.verificationCriteria.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>Verification:</Text>
          {plan.verificationCriteria.map((criteria, i) => (
            <Text key={i} dimColor>
              {'  '}• {criteria}
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}

/** 计划审批组件 */
export function PlanApprovalPrompt({ plan, onApprove, onReject }: PlanApprovalProps): ReactElement {
  useInput((input, key) => {
    if (key.escape) {
      onReject('user cancelled');
      return;
    }
    if (input === 'y' || input === 'Y') {
      onApprove();
      return;
    }
    if (input === 'n' || input === 'N') {
      onReject('user rejected');
      return;
    }
    // Phase 2: 编辑模式简化为跳过任务
    if (input === 'e' || input === 'E') {
      // TODO: Phase 2 简化版暂不支持编辑，直接提示
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <PlanDisplay plan={plan} />
      <Box marginTop={1}>
        <Text color="green">[y]</Text>
        <Text> Approve </Text>
        <Text color="yellow">[e]</Text>
        <Text> Edit </Text>
        <Text color="red">[n]</Text>
        <Text> Reject </Text>
        <Text dimColor>[Esc] Cancel</Text>
      </Box>
    </Box>
  );
}

/** 将计划格式化为文本（用于注入 system prompt） */
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

function formatTaskForPrompt(task: PlanTask, indent: number): string {
  const prefix = '  '.repeat(indent);
  const statusIcon = taskStatusIcon(task.status);
  let line = `${prefix}${task.id}. [${statusIcon}] ${task.title}`;

  if (task.acceptance.length > 0) {
    line += ` (acceptance: ${task.acceptance.join(', ')})`;
  }

  const lines = [line];
  for (const child of task.children) {
    lines.push(formatTaskForPrompt(child, indent + 1));
  }

  return lines.join('\n');
}
