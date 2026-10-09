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
import { Box, Text, useInput } from 'ink';
import type { ReactElement } from 'react';

import type { Plan, PlanTask } from '@yo-harness/core/types/plan.js';

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
  useInput((input: string, key: { escape?: boolean }) => {
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

/** 将计划格式化为文本（用于注入 system prompt）—— 复用 core 实现 */
export { formatPlanForPrompt } from '@yo-harness/core/types/plan.js';
