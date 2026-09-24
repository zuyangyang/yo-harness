/**
 * 事件模型 —— 平台的全局骨架。
 *
 * 一切动作/观察皆为事件（append-only）；CLI 渲染、会话 resume 重放、
 * 未来的 Web UI 都是事件流的投影。schema 与 TS 类型经 z.infer 绑定，
 * 单一事实来源，存取边界用它校验。
 */
import { z } from 'zod';

/** 模型发起的一次工具调用 */
export const ToolCallSchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const TurnEndReasonSchema = z.enum([
  'done',
  'max_steps',
  'budget',
  'interrupted',
  'error',
]);
export type TurnEndReason = z.infer<typeof TurnEndReasonSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_started'),
    model: z.string(),
    cwd: z.string(),
  }),
  z.object({
    type: z.literal('user_input'),
    content: z.string(),
  }),
  z.object({
    type: z.literal('assistant_text'),
    text: z.string(),
    /** 可能为空数组；与后续 tool_call/tool_result 以 callId 关联 */
    toolCalls: z.array(ToolCallSchema),
  }),
  z.object({
    type: z.literal('tool_call'),
    callId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    callId: z.string(),
    ok: z.boolean(),
    content: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('approval_request'),
    callId: z.string(),
    toolName: z.string(),
    summary: z.string(),
  }),
  z.object({
    type: z.literal('approval_result'),
    callId: z.string(),
    approved: z.boolean(),
    scope: z.enum(['once', 'session']),
  }),
  z.object({
    type: z.literal('context_elided'),
    count: z.number().int().nonnegative(),
    freedEstTokens: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('error'),
    stage: z.enum(['llm', 'tool', 'loop', 'storage']),
    message: z.string(),
    recoverable: z.boolean(),
  }),
  z.object({
    type: z.literal('turn_started'),
    turnId: z.string(),
  }),
  z.object({
    type: z.literal('turn_completed'),
    turnId: z.string(),
    reason: TurnEndReasonSchema,
    usage: UsageSchema,
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** 存储层信封：事件 + 定位信息。seq 在会话内单调递增，是重放排序依据。 */
export interface EventEnvelope {
  id: number;
  sessionId: string;
  seq: number;
  /** ISO 8601 */
  ts: string;
  payload: AgentEvent;
}
