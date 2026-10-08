/**
 * Turn grouping: converts flat EventEnvelope[] into structured Turn[].
 *
 * A "turn" = one user message + all agent actions until the next user message.
 * Within a turn, the last assistant_text (with no tool_call after it) is the FinalReply;
 * earlier assistant_text events are thinking.
 */
import type { EventEnvelope } from '@yo-harness/core/types/events.js';

export interface ToolStep {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: {
    ok: boolean;
    content: string;
    durationMs: number;
  };
  /** 正在等待人工审批（approval_request 到达且尚未裁决） */
  waitingApproval?: {
    summary: string;
  };
  /** 审批裁决结果（approval_result 到达后填充，同时清除 waitingApproval） */
  approvalResult?: {
    approved: boolean;
  };
}

export type TurnMetaKind = 'context' | 'checkpoint' | 'memory' | 'goal';

export interface TurnMetaItem {
  key: string;
  kind: TurnMetaKind;
  label: string;
  detail: string;
}

export interface Turn {
  id: string;
  userMessage: string;
  thinkingTexts: string[];
  toolSteps: ToolStep[];
  finalText: string;
  errors: { stage: string; message: string; recoverable: boolean }[];
  meta: TurnMetaItem[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** 生成本轮的生效模型（来自最近的 session_started 事件；旧数据可能缺失） */
  model?: string;
  startTime: string;
  endTime?: string;
  endReason?: string;
}

export function groupEventsIntoTurns(events: EventEnvelope[]): Turn[] {
  const rawTurns = splitByUserInput(events);
  return rawTurns.map((raw, idx) => buildTurn(raw, idx));
}

interface RawTurn {
  userMessage: string;
  startTime: string;
  /** 本 turn 开始时的生效模型 */
  model?: string;
  events: EventEnvelope[];
}

function splitByUserInput(events: EventEnvelope[]): RawTurn[] {
  const turns: RawTurn[] = [];
  let current: RawTurn | null = null;
  // 最近一次 session_started 声明的模型；下一条 user_input 起生效
  let activeModel: string | undefined;

  for (const envelope of events) {
    if (envelope.payload.type === 'session_started') {
      activeModel = envelope.payload.model;
      continue;
    }
    if (envelope.payload.type === 'user_input') {
      if (current) turns.push(current);
      current = {
        userMessage: envelope.payload.content,
        startTime: envelope.ts,
        ...(activeModel !== undefined ? { model: activeModel } : {}),
        events: [],
      };
      continue;
    }
    if (current) {
      current.events.push(envelope);
    }
  }

  if (current) turns.push(current);
  return turns;
}

function buildTurn(raw: RawTurn, index: number): Turn {
  const thinkingTexts: string[] = [];
  const allAssistantTexts: { text: string; hasToolCalls: boolean }[] = [];
  const toolStepMap = new Map<string, ToolStep>();
  const errors: Turn['errors'] = [];
  const meta: TurnMetaItem[] = [];
  let metaSeq = 0;
  let usage: Turn['usage'];
  let endTime: string | undefined;
  let endReason: string | undefined;

  const addMeta = (kind: TurnMetaKind, label: string, detail: string): void => {
    meta.push({ key: kind + '-' + metaSeq++, kind, label, detail });
  };

  for (const envelope of raw.events) {
    const event = envelope.payload;

    switch (event.type) {
      case 'assistant_text':
        allAssistantTexts.push({ text: event.text, hasToolCalls: event.toolCalls.length > 0 });
        if (event.toolCalls.length > 0) {
          thinkingTexts.push(event.text);
        }
        break;

      case 'tool_call':
        toolStepMap.set(event.callId, {
          callId: event.callId,
          toolName: event.toolName,
          args: event.args,
        });
        break;

      case 'tool_result': {
        const step = toolStepMap.get(event.callId);
        if (step) {
          step.result = {
            ok: event.ok,
            content: event.content,
            durationMs: event.durationMs,
          };
          // 防御性清理：工具已执行完就不可能仍在等待（旧日志缺 approval_result 时兜底）
          delete step.waitingApproval;
        }
        break;
      }

      case 'approval_request': {
        const step = toolStepMap.get(event.callId);
        if (step) {
          step.waitingApproval = { summary: event.summary };
        }
        break;
      }

      case 'approval_result': {
        // 审批已决（允许或拒绝）→ 清除等待态，避免 UI 永远显示 waiting
        const step = toolStepMap.get(event.callId);
        if (step) {
          step.approvalResult = { approved: event.approved };
          delete step.waitingApproval;
        }
        break;
      }

      case 'error':
        errors.push({ stage: event.stage, message: event.message, recoverable: event.recoverable });
        break;

      case 'turn_completed':
        usage = event.usage;
        endTime = envelope.ts;
        endReason = event.reason;
        break;

      case 'context_compressed':
        addMeta(
          'context',
          '压缩上下文',
          event.beforeTokens + '→' + event.afterTokens + ' tokens',
        );
        break;

      case 'context_elided':
        addMeta('context', '裁剪上下文', '释放 ~' + event.freedEstTokens + ' tokens');
        break;

      case 'checkpoint_created':
        addMeta('checkpoint', '创建检查点', event.files.length + ' 文件 · ' + event.source);
        break;

      case 'checkpoint_restored':
        addMeta(
          'checkpoint',
          event.direction === 'undo' ? '撤销变更' : '重做变更',
          event.files.length + ' 文件',
        );
        break;

      case 'memory_extracted':
        addMeta('memory', '提取记忆', event.count + ' 条');
        break;

      case 'memory_injected':
        addMeta('memory', '注入记忆', event.count + ' 条');
        break;

      case 'goal_reminder':
        addMeta('goal', '目标提醒', event.goal.slice(0, 60));
        break;

      default:
        break;
    }
  }

  const finalText = determineFinalText(allAssistantTexts);

  return {
    id: 'turn-' + index,
    userMessage: raw.userMessage,
    thinkingTexts,
    toolSteps: Array.from(toolStepMap.values()),
    finalText,
    errors,
    meta,
    ...(usage ? { usage } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    startTime: raw.startTime,
    ...(endTime ? { endTime } : {}),
    ...(endReason ? { endReason } : {}),
  };
}

function determineFinalText(
  allAssistantTexts: { text: string; hasToolCalls: boolean }[],
): string {
  if (allAssistantTexts.length === 0) return '';

  const hasToolCalls = allAssistantTexts.some((t) => t.hasToolCalls);

  if (!hasToolCalls && allAssistantTexts.length === 1) {
    const first = allAssistantTexts[0];
    return first ? first.text : '';
  }

  for (let i = allAssistantTexts.length - 1; i >= 0; i--) {
    const item = allAssistantTexts[i];
    if (item && !item.hasToolCalls) {
      return item.text;
    }
  }

  return '';
}
