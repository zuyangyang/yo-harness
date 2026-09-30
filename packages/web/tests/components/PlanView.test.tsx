/**
 * PlanView 单元测试：渲染任务树 + 进度计算。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlanView } from '../../src/components/Plan/PlanView.js';

const mockPlan = {
  id: 'p1',
  objective: 'Implement login feature',
  createdAt: '2026-01-01',
  tasks: [
    {
      id: 't1',
      title: 'Create login form',
      status: 'completed' as const,
      acceptance: ['Form renders', 'Validation works'],
      children: [
        {
          id: 't1-1',
          title: 'Add email field',
          status: 'completed' as const,
          acceptance: [],
          children: [],
        },
        {
          id: 't1-2',
          title: 'Add password field',
          status: 'completed' as const,
          acceptance: [],
          children: [],
        },
      ],
    },
    {
      id: 't2',
      title: 'Connect to API',
      status: 'in_progress' as const,
      acceptance: ['API call succeeds'],
      children: [],
    },
    {
      id: 't3',
      title: 'Write tests',
      status: 'pending' as const,
      acceptance: ['Tests pass'],
      children: [],
    },
  ],
  verificationCriteria: ['Login works end-to-end', 'Error handling'],
};

describe('PlanView', () => {
  it('渲染目标', () => {
    render(<PlanView plan={mockPlan} />);
    expect(screen.getByText('Implement login feature')).toBeTruthy();
  });

  it('渲染所有任务标题', () => {
    render(<PlanView plan={mockPlan} />);
    expect(screen.getAllByText('Create login form').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Add email field').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Add password field').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Connect to API').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Write tests').length).toBeGreaterThanOrEqual(1);
  });

  it('计算正确进度（含子任务）', () => {
    render(<PlanView plan={mockPlan} />);
    // 5 tasks total: t1, t1-1, t1-2, t2, t3
    // 3 completed: t1, t1-1, t1-2
    // Progress: 3/5 = 60%
    const progressEls = screen.getAllByText('3/5 tasks (60%)');
    expect(progressEls.length).toBeGreaterThanOrEqual(1);
  });

  it('渲染验证标准', () => {
    render(<PlanView plan={mockPlan} />);
    expect(screen.getAllByText('Login works end-to-end').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Error handling').length).toBeGreaterThanOrEqual(1);
  });

  it('已完成任务显示删除线样式', () => {
    const { container } = render(<PlanView plan={mockPlan} />);
    const completedTasks = container.querySelectorAll('.plan-task--completed');
    expect(completedTasks.length).toBe(3); // t1, t1-1, t1-2
  });

  it('空计划显示 0%', () => {
    const emptyPlan = {
      id: 'p2',
      objective: 'Empty plan',
      tasks: [],
      verificationCriteria: [],
      createdAt: '2026-01-01',
    };
    render(<PlanView plan={emptyPlan} />);
    const progressEls = screen.getAllByText('0/0 tasks (0%)');
    expect(progressEls.length).toBeGreaterThanOrEqual(1);
  });
});
