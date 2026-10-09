/**
 * 目标追踪器 —— 长任务中防止模型"忘了自己在干什么"。
 *
 * 做两件事：
 * 1. 记住目标：从用户首次输入提取目标陈述，始终保持在上下文中。
 * 2. 检测漂移：每隔 N 步检查是否有进展，如果连续 M 步没有进展，
 *    注入提醒让模型自检。
 *
 * 设计选择：
 * - 漂移检测不调 LLM（成本为零），直接注入固定格式文本。
 * - 目标陈述简单取用户输入前 200 字符（Phase 2 简化版）。
 * - 与 Plan 集成：syncWithPlan() 同步任务列表作为进度检查项。
 */
import type { ToolCall } from '../types/events.js';
import { formatPlanForPrompt } from '../types/plan.js';
import type { Plan } from '../types/plan.js';

/** 目标状态 */
export interface GoalState {
  /** 目标陈述（从用户首次输入精炼） */
  statement: string;
  /** 进度检查项（模型在规划或执行中产出） */
  checkpoints: string[];
  /** 上次有明确进展的步数 */
  lastProgressStep: number;
}

/** 目标追踪器依赖注入 */
export interface GoalTrackerDeps {
  /** 连续多少步无进展时注入提醒（默认 8） */
  driftThreshold: number;
}

/** 默认漂移阈值 */
export const DEFAULT_DRIFT_THRESHOLD = 8;

export class GoalTracker {
  private state: GoalState | undefined;
  /** 已批准的执行计划（syncWithPlan 注入，供 system prompt 附带） */
  private plan: Plan | undefined;

  constructor(private readonly deps: GoalTrackerDeps) {}

  /** 当前目标陈述（供外部读取） */
  get statement(): string | undefined {
    return this.state?.statement;
  }

  /** 当前状态（供测试/调试） */
  get currentState(): GoalState | undefined {
    return this.state;
  }

  /** 从用户首次输入初始化目标 */
  initialize(userInput: string): void {
    // 简单版：直接取用户输入前 200 字符作为目标陈述
    this.state = {
      statement: userInput.slice(0, 200),
      checkpoints: [],
      lastProgressStep: 0,
    };
  }

  /** 是否已初始化 */
  isInitialized(): boolean {
    return this.state !== undefined;
  }

  /** 注入计划时同步检查项，并保存完整计划用于 system prompt 注入 */
  syncWithPlan(plan: Plan): void {
    if (this.state === undefined) return;
    this.state.checkpoints = plan.tasks.map((t) => `[${t.status}] ${t.title}`);
    this.state.lastProgressStep = 0;
    this.plan = plan;
  }

  /** 任务状态更新时推进进度 */
  onTaskCompleted(step: number): void {
    if (this.state === undefined) return;
    this.state.lastProgressStep = step;
  }

  /** 手动标记进展（用于无计划场景） */
  markProgress(step: number): void {
    if (this.state === undefined) return;
    this.state.lastProgressStep = step;
  }

  /**
   * 每步调用：检查是否需要注入漂移提醒。
   * 返回提醒文本（undefined = 不需要提醒）。
   */
  checkDrift(currentStep: number, recentToolCalls: ToolCall[]): string | undefined {
    if (this.state === undefined) return undefined;
    const stepsSinceProgress = currentStep - this.state.lastProgressStep;
    if (stepsSinceProgress < this.deps.driftThreshold) return undefined;

    // 构造提醒（不调 LLM，直接注入固定文本，成本为零）
    const recentTools = recentToolCalls
      .slice(-5)
      .map((c) => c.toolName)
      .join(', ');

    return [
      `⚠ Goal drift check: ${stepsSinceProgress} steps since last progress.`,
      `Current goal: ${this.state.statement}`,
      `Recent actions: ${recentTools || '(none)'}`,
      `Please verify you are still working toward the goal. If not, explain what changed and adjust your approach.`,
    ].join('\n');
  }

  /** 生成注入 system prompt 的目标摘要（含已批准的计划，§9.4） */
  toSystemPromptInjection(): string | undefined {
    if (this.state === undefined) return undefined;
    let text = `<current-goal>\n${this.state.statement}\n`;
    if (this.plan !== undefined) {
      // 已批准计划：注入完整结构化计划（objective / 任务树 / 验收标准）
      text += `\n${formatPlanForPrompt(this.plan)}\n`;
    } else if (this.state.checkpoints.length > 0) {
      text += `\nProgress:\n${this.state.checkpoints.join('\n')}\n`;
    }
    text += `</current-goal>`;
    return text;
  }

  /** 重置状态（用于测试或新回合） */
  reset(): void {
    this.state = undefined;
  }
}
