/**
 * 规划器子代理 —— 只读探索 → 结构化计划。
 *
 * 复杂任务直接丢给 ReAct 循环容易目标漂移。规划器让模型先用只读工具
 * 探索代码库，产出结构化计划，用户确认后交给执行者按计划推进。
 *
 * 关键约束：
 * - 规划阶段只能用只读工具（read_file、list_dir、shell 只读命令）。
 * - 计划是结构化 JSON（Plan 类型），不是自由文本。
 * - 模型输出计划后用 PlanOutputSchema 做 zod 校验，失败则反馈修正。
 * - 规划阶段独立于主循环，有自己的消息序列和步数限制。
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from '../types/common.js';
import type { ChatMessage, LLMClient } from '../types/llm.js';
import { PlanOutputSchema, type Plan, type PlanOutput, type PlanTask } from '../types/plan.js';
import type { SandboxProvider } from '../types/sandbox.js';
import type { ToolResult } from '../types/tools.js';
import type { EventBus } from './event-bus.js';
import type { ToolResolver } from './ports.js';
import type { PermissionManager } from './permission.js';

/** 规划器依赖注入 */
export interface PlannerDeps {
  llm: LLMClient;
  /** 只读工具子集（由 readOnlyResolver 过滤） */
  tools: ToolResolver;
  permission: PermissionManager;
  sandbox: SandboxProvider;
  sessionId: string;
  cwd: string;
  logger: Logger;
  bus: EventBus;
  /** 最大探索步数（防止规划阶段空转） */
  maxExploreSteps: number;
  /** 规划 LLM 的 temperature（缺省 0，结构化输出求稳定） */
  temperature?: number;
}

/** 规划阶段 system prompt：强调只读探索与结构化输出 */
const PLANNING_SYSTEM_PROMPT = `You are a planning agent. Your job is to explore the codebase using read-only tools and produce a structured execution plan.

Rules:
- ONLY use read-only tools (read_file, list_dir). Do NOT modify anything.
- When you have enough information, output the plan as a JSON object matching this schema:
  {
    "objective": "<one-sentence summary of the user's goal>",
    "tasks": [
      {
        "id": "1",
        "title": "<one-line description>",
        "acceptance": ["<criterion 1>", "<criterion 2>"],
        "children": [
          {
            "id": "1.1",
            "title": "<sub-task description>",
            "acceptance": ["<criterion>"]
          }
        ]
      }
    ],
    "verificationCriteria": ["<global verification criterion>"]
  }
- The plan should decompose the user's request into ordered, verifiable tasks.
- Each task should have clear acceptance criteria.
- Be concrete: reference actual file paths, function names, and patterns you found during exploration.
- Output ONLY the JSON object, no additional text before or after.`;

/** 规划器结果 */
export interface PlanResult {
  plan: Plan;
  /** 探索阶段使用的消息历史（可用于后续执行阶段的上下文） */
  explorationMessages: ChatMessage[];
}

export class Planner {
  constructor(private readonly deps: PlannerDeps) {}

  /**
   * 规划阶段：只读探索 → 产出结构化计划。
   * 返回 PlanResult 或 null（用户取消 / 达到步数上限且未产出计划）。
   */
  async plan(userRequest: string): Promise<PlanResult | null> {
    const { llm, tools, permission, sessionId, cwd, logger, bus, maxExploreSteps } = this.deps;

    // 构建规划专用消息序列
    const messages: ChatMessage[] = [
      { role: 'user', text: userRequest },
    ];

    let stepCount = 0;
    let planOutput: PlanOutput | undefined;
    let parseAttempts = 0;
    const maxParseAttempts = 2;

    while (stepCount < maxExploreSteps) {
      stepCount++;
      logger.debug(`planner: exploration step ${stepCount}/${maxExploreSteps}`);

      // 调用 LLM
      const resp = await llm.chat({
        system: PLANNING_SYSTEM_PROMPT,
        messages,
        tools: tools.specs(),
        maxTokens: 4096,
        temperature: this.deps.temperature ?? 0,
      });

      // 检查是否有工具调用
      if (resp.toolCalls.length === 0) {
        // 模型没有调用工具，尝试解析其输出为计划 JSON
        const parsed = this.tryParsePlan(resp.text);
        if (parsed !== undefined) {
          planOutput = parsed;
          // 添加 assistant 消息到历史
          messages.push({ role: 'assistant', text: resp.text, toolCalls: [] });
          break;
        }

        // 解析失败，检查是否还有重试机会
        if (parseAttempts >= maxParseAttempts) {
          logger.warn('planner: failed to parse plan after max attempts');
          messages.push({ role: 'assistant', text: resp.text, toolCalls: [] });
          break;
        }

        // 反馈解析错误给模型
        parseAttempts++;
        const errorMsg = `Your output did not match the required JSON schema. Please output ONLY a valid JSON object matching the schema. Error: ${parsed === undefined ? 'invalid JSON' : 'missing required fields'}`;
        messages.push({ role: 'assistant', text: resp.text, toolCalls: [] });
        messages.push({ role: 'user', text: errorMsg });
        continue;
      }

      // 有工具调用，执行只读工具
      messages.push({ role: 'assistant', text: resp.text, toolCalls: resp.toolCalls });

      for (const toolCall of resp.toolCalls) {
        const tool = tools.get(toolCall.toolName);
        if (tool === undefined) {
          messages.push({
            role: 'tool',
            callId: toolCall.callId,
            text: `unknown tool: ${toolCall.toolName}`,
            isError: true,
          });
          continue;
        }

        // 权限检查（规划阶段通常自动批准只读操作）
        const decision = await permission.request(tool, toolCall.args, toolCall.callId);
        if (!decision.approved) {
          messages.push({
            role: 'tool',
            callId: toolCall.callId,
            text: 'User denied this action.',
            isError: true,
          });
          continue;
        }

        // 执行工具
        let result: ToolResult;
        try {
          result = await tool.run(toolCall.args, { sessionId, cwd, logger, sandbox: this.deps.sandbox });
        } catch (err) {
          result = { ok: false, content: `tool crashed: ${String(err)}` };
        }

        messages.push({
          role: 'tool',
          callId: toolCall.callId,
          text: result.content,
          isError: !result.ok,
        });
      }
    }

    // 如果未能产出计划，返回 null
    if (planOutput === undefined) {
      return null;
    }

    // 构建 Plan 对象
    const plan: Plan = {
      id: randomUUID(),
      objective: planOutput.objective,
      tasks: planOutput.tasks.map((t) => this.toPlanTask(t)),
      verificationCriteria: planOutput.verificationCriteria,
      createdAt: new Date().toISOString(),
    };

    // 发送 plan_created 事件（通过 bus 广播，由 agent-loop 负责落库）
    bus.emit('event', {
      id: 0,
      sessionId,
      seq: 0,
      ts: plan.createdAt,
      payload: { type: 'plan_created', plan },
    });

    return { plan, explorationMessages: messages };
  }

  /** 尝试解析文本为计划 JSON */
  private tryParsePlan(text: string): PlanOutput | undefined {
    // 尝试提取 JSON 块（可能被 markdown 代码块包裹）
    const jsonMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const jsonText = (jsonMatch?.[1] ?? text).trim();

    try {
      const parsed = JSON.parse(jsonText) as unknown;
      const result = PlanOutputSchema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** 将 PlanOutput 中的任务转换为 PlanTask（添加 status 字段） */
  private toPlanTask(task: PlanOutput['tasks'][number]): PlanTask {
    return {
      id: task.id,
      title: task.title,
      status: 'pending',
      acceptance: task.acceptance,
      children: task.children.map((child) => ({
        id: child.id,
        title: child.title,
        status: 'pending',
        acceptance: child.acceptance,
        children: [],
      })),
    };
  }
}

/**
 * 从 ToolResolver 过滤出只读工具子集。
 * 规划阶段使用此函数包装主 ToolResolver，确保只能调用 risk === 'read' 的工具。
 */
export function readOnlyResolver(resolver: ToolResolver): ToolResolver {
  return {
    get(name: string) {
      const tool = resolver.get(name);
      if (tool === undefined) return undefined;
      return tool.risk === 'read' ? tool : undefined;
    },
    specs() {
      return resolver.specs().filter((spec) => resolver.get(spec.name)?.risk === 'read');
    },
  };
}
