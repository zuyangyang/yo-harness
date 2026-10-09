import { describe, expect, it } from 'vitest';

import { DEFAULT_DRIFT_THRESHOLD, GoalTracker } from '../../src/core/goal-tracker.js';
import type { ToolCall } from '../../src/types/events.js';
import type { Plan } from '../../src/types/plan.js';

// ---------------------------------------------------------------------------
// 测试设施
// ---------------------------------------------------------------------------

const makeToolCall = (toolName: string): ToolCall => ({
  callId: `c-${toolName}`,
  toolName,
  args: {},
});

const makePlan = (tasks: { id: string; title: string; status: string }[]): Plan => ({
  id: 'plan-1',
  objective: 'Test objective',
  tasks: tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status as Plan['tasks'][0]['status'],
    acceptance: [],
    children: [],
  })),
  verificationCriteria: [],
  createdAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// GoalTracker 测试
// ---------------------------------------------------------------------------

describe('GoalTracker', () => {
  it('默认漂移阈值', () => {
    expect(DEFAULT_DRIFT_THRESHOLD).toBe(8);
  });

  it('未初始化时 checkDrift 返回 undefined', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    expect(tracker.checkDrift(10, [])).toBeUndefined();
    expect(tracker.toSystemPromptInjection()).toBeUndefined();
    expect(tracker.isInitialized()).toBe(false);
  });

  it('initialize 设置目标陈述（截取前 200 字符）', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    const longInput = 'a'.repeat(300);
    tracker.initialize(longInput);

    expect(tracker.isInitialized()).toBe(true);
    expect(tracker.statement).toBe('a'.repeat(200));
    expect(tracker.currentState?.lastProgressStep).toBe(0);
  });

  it('短输入完整保留', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    tracker.initialize('Fix the login bug');

    expect(tracker.statement).toBe('Fix the login bug');
  });

  it('checkDrift 未达阈值时返回 undefined', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    tracker.initialize('Test goal');

    // 步数 5，上次进展在 0 → 5 < 8，不提醒
    expect(tracker.checkDrift(5, [])).toBeUndefined();
  });

  it('checkDrift 达到阈值时返回提醒文本', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    tracker.initialize('Fix the login bug');

    // 步数 8，上次进展在 0 → 8 >= 8，提醒
    const reminder = tracker.checkDrift(8, [makeToolCall('read_file')]);
    expect(reminder).toBeDefined();
    expect(reminder).toContain('Goal drift check');
    expect(reminder).toContain('8 steps since last progress');
    expect(reminder).toContain('Fix the login bug');
    expect(reminder).toContain('read_file');
  });

  it('checkDrift 包含最近 5 个工具调用', () => {
    const tracker = new GoalTracker({ driftThreshold: 3 });
    tracker.initialize('Test');

    const tools = [
      makeToolCall('read_file'),
      makeToolCall('list_dir'),
      makeToolCall('shell'),
      makeToolCall('web_search'),
      makeToolCall('read_file'),
      makeToolCall('write_file'), // 第 6 个，应被截断
    ];

    const reminder = tracker.checkDrift(3, tools);
    expect(reminder).toContain('list_dir');
    expect(reminder).toContain('shell');
    expect(reminder).toContain('web_search');
    expect(reminder).toContain('read_file');
    expect(reminder).toContain('write_file');
    // 第 1 个 read_file 应被截断
    expect(reminder?.match(/read_file/g)?.length).toBe(1);
  });

  it('onTaskCompleted 推进 lastProgressStep', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    tracker.initialize('Test');

    tracker.onTaskCompleted(5);
    expect(tracker.currentState?.lastProgressStep).toBe(5);

    // 步数 10，上次进展在 5 → 5 < 8，不提醒
    expect(tracker.checkDrift(10, [])).toBeUndefined();

    // 步数 13，上次进展在 5 → 8 >= 8，提醒
    expect(tracker.checkDrift(13, [])).toBeDefined();
  });

  it('markProgress 手动标记进展', () => {
    const tracker = new GoalTracker({ driftThreshold: 5 });
    tracker.initialize('Test');

    tracker.markProgress(3);
    expect(tracker.currentState?.lastProgressStep).toBe(3);
  });

  it('syncWithPlan 同步任务列表到 checkpoints', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    tracker.initialize('Test');

    const plan = makePlan([
      { id: '1', title: 'First task', status: 'pending' },
      { id: '2', title: 'Second task', status: 'in_progress' },
      { id: '3', title: 'Third task', status: 'completed' },
    ]);

    tracker.syncWithPlan(plan);

    expect(tracker.currentState?.checkpoints).toEqual([
      '[pending] First task',
      '[in_progress] Second task',
      '[completed] Third task',
    ]);
    expect(tracker.currentState?.lastProgressStep).toBe(0);
  });

  it('toSystemPromptInjection 生成目标摘要', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    tracker.initialize('Fix the login bug');

    const injection = tracker.toSystemPromptInjection();
    expect(injection).toContain('<current-goal>');
    expect(injection).toContain('Fix the login bug');
    expect(injection).toContain('</current-goal>');
  });

  it('toSystemPromptInjection 注入完整计划（§9.4）', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    tracker.initialize('Test');

    const plan = makePlan([
      { id: '1', title: 'Task A', status: 'completed' },
      { id: '2', title: 'Task B', status: 'pending' },
    ]);
    tracker.syncWithPlan(plan);

    const injection = tracker.toSystemPromptInjection();
    expect(injection).toContain('<execution-plan>');
    expect(injection).toContain('Objective: Test objective');
    expect(injection).toContain('1. [✓] Task A');
    expect(injection).toContain('2. [○] Task B');
    expect(injection).toContain('</execution-plan>');
  });

  it('reset 清除状态', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });
    tracker.initialize('Test');
    expect(tracker.isInitialized()).toBe(true);

    tracker.reset();
    expect(tracker.isInitialized()).toBe(false);
    expect(tracker.statement).toBeUndefined();
  });

  it('未初始化时 onTaskCompleted/markProgress/syncWithPlan 不抛错', () => {
    const tracker = new GoalTracker({ driftThreshold: 8 });

    // 这些操作在未初始化时应该是空操作
    tracker.onTaskCompleted(5);
    tracker.markProgress(3);
    tracker.syncWithPlan(makePlan([]));

    expect(tracker.isInitialized()).toBe(false);
  });
});
