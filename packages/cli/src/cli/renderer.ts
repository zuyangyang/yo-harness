/**
 * 事件 → 渲染行的纯映射（§6.8）。
 *
 * 设计约束：
 * - 不依赖 ink / react —— 只产出结构化 RenderLine（文本 + 颜色/缩进样式），
 *   由 app.tsx 决定怎么画；因此 renderer 可以完整单测（Step 8 的测试重心）。
 * - 流式文本由 pushDelta 累积、stream 读取；assistant_text 事件到达即提交
 *   为正式行并清空流式缓冲（回放 / fake provider 等无流式场景同样成立）。
 * - tool_result 事件只带 callId，tool_call 时先记下 callId → 摘要映射，
 *   结果行才能还原出 `✓ write_file src/foo.ts · 45ms` 这样的折叠单行。
 * - 摘要复用 core/permission 的 summarizeToolCall（同一份脱敏逻辑，
 *   审批 UI 与结果行展示保持一致）。
 */
import { summarizeToolCall } from '@yo-harness/core/core/permission.js';
import type { AgentEvent } from '@yo-harness/core/types/events.js';

export type RenderColor = 'cyan' | 'green' | 'red' | 'yellow' | 'gray' | 'magenta';

export interface RenderLine {
  text: string;
  color?: RenderColor;
  bold?: boolean;
  dim?: boolean;
  /** 缩进空格数（工具行缩进一级，视觉上从属于 assistant 消息） */
  indent?: number;
}

export interface LineStyle {
  color?: RenderColor;
  bold?: boolean;
  dim?: boolean;
  indent?: number;
}

const PREVIEW_MAX = 100;

/** 构造 RenderLine（app.tsx 的本地提示行也用它，保证样式约定一致） */
export function line(text: string, style?: LineStyle): RenderLine {
  const out: RenderLine = { text };
  if (style?.color !== undefined) out.color = style.color;
  if (style?.bold === true) out.bold = true;
  if (style?.dim === true) out.dim = true;
  if (style?.indent !== undefined) out.indent = style.indent;
  return out;
}

/** 工具结果预览：压成单行、截断 —— 折叠摘要不换屏 */
function contentPreview(content: string): string {
  const flat = content.replaceAll(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export class RenderModel {
  private pendingStream = '';
  private readonly toolSummaries = new Map<string, string>();

  /** 当前未提交的流式文本（app 节流刷新用） */
  get stream(): string {
    return this.pendingStream;
  }

  /** llm_delta 到达时累积；assistant_text 提交后自动清空 */
  pushDelta(delta: string): void {
    this.pendingStream += delta;
  }

  /** 事件 → 行块。不抛错、无副作用（除了自身折叠状态）。 */
  push(event: AgentEvent): RenderLine[] {
    switch (event.type) {
      case 'session_started':
        return [line(`● session · ${event.model} · ${event.cwd}`, { dim: true })];

      case 'user_input':
        return [line(`❯ ${event.content}`, { color: 'cyan', bold: true })];

      case 'assistant_text': {
        this.pendingStream = '';
        if (event.text.length === 0) return [];
        return [line(event.text)];
      }

      case 'tool_call': {
        const summary = summarizeToolCall(event.toolName, event.args);
        this.toolSummaries.set(event.callId, summary);
        return [line(`→ ${summary}`, { dim: true, indent: 2 })];
      }

      case 'tool_result': {
        const summary = this.toolSummaries.get(event.callId) ?? `#${event.callId}`;
        const duration = formatDuration(event.durationMs);
        if (event.ok) {
          return [line(`✓ ${summary} · ${duration}`, { color: 'green', indent: 2 })];
        }
        return [
          line(`✗ ${summary} · ${duration} — ${contentPreview(event.content)}`, {
            color: 'red',
            indent: 2,
          }),
        ];
      }

      case 'approval_request':
        return [line(`? approval needed: ${event.summary}`, { color: 'yellow', indent: 2 })];

      case 'approval_result':
        return [
          line(
            event.approved ? `✓ approved (${event.scope})` : '✗ denied',
            { color: event.approved ? 'green' : 'red', dim: true, indent: 2 },
          ),
        ];

      case 'context_elided':
        return [
          line(`⋯ context trimmed: ${event.count} events, ~${event.freedEstTokens} tokens freed`, {
            dim: true,
          }),
        ];

      case 'error':
        return [
          line(`✗ error [${event.stage}]${event.recoverable ? ' (recoverable)' : ''}: ${event.message}`, {
            color: 'red',
          }),
        ];

      case 'turn_completed': {
        const usage = `in ${event.usage.inputTokens} / out ${event.usage.outputTokens}`;
        const reason = event.reason === 'done' ? 'turn done' : `turn ended: ${event.reason}`;
        return [line(`· ${reason} · ${usage}`, { dim: true })];
      }

      case 'turn_started':
        return [];

      // ─── Phase 2 新增事件渲染（基础版，Step 7 细化） ───

      case 'context_compressed':
        return [
          line(
            `⋯ context compressed: ${event.compressedCount} items (${event.strategy}), ~${event.beforeTokens - event.afterTokens} tokens freed`,
            { dim: true },
          ),
        ];

      case 'checkpoint_created':
        return [
          line(`◉ checkpoint saved: ${event.files.join(', ')}`, { dim: true }),
        ];

      case 'checkpoint_restored':
        return [
          line(
            `↩ checkpoint ${event.direction}: ${event.files.join(', ')}`,
            { color: 'yellow' },
          ),
        ];

      case 'plan_created':
        return [line('📋 plan created', { color: 'magenta', bold: true })];

      case 'plan_approved':
        return [line('✓ plan approved', { color: 'green' })];

      case 'plan_rejected':
        return [line(`✗ plan rejected: ${event.reason}`, { color: 'red' })];

      case 'plan_task_updated':
        return [
          line(`  ✓ task ${event.taskId} → ${event.status}`, { color: 'green', dim: true, indent: 2 }),
        ];

      case 'goal_reminder':
        return [
          line(`⚠ goal drift (${event.stepsSinceProgress} steps): ${event.goal}`, {
            color: 'yellow',
          }),
        ];

      // ─── Phase 3 新增事件 ───
      case 'memory_extracted':
        return [line(`[memory] extracted ${event.count} memories (${event.source})`, { color: 'cyan', dim: true })];

      case 'memory_injected':
        return [line(`[memory] injected ${event.count} memories`, { color: 'cyan', dim: true })];

      case 'task_started':
        return [line(`[bg] task ${event.taskId}: ${event.description}`, { color: 'magenta' })];

      case 'task_completed':
        return [line(`[bg] task ${event.taskId} completed (${event.reason})`, { color: 'green' })];

      case 'task_failed':
        return [line(`[bg] task ${event.taskId} failed: ${event.error}`, { color: 'red' })];

      default: {
        // 穷尽性检查：新增事件类型时这里编译报错，提醒补渲染
        const exhaustive: never = event;
        void exhaustive;
        return [];
      }
    }
  }
}
