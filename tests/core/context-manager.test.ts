import { describe, expect, it } from 'vitest';

import {
  ContextManager,
  DEFAULT_BODY_TARGET_RATIO,
  DEFAULT_KEEP_RECENT,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  DEFAULT_TOOLS_SYSTEM_RESERVE_TOKENS,
  toolElidedPlaceholder,
} from '../../src/core/context-manager.js';
import type { ContextManagerConfig } from '../../src/core/context-manager.js';
import type { AgentEvent, ToolCall } from '../../src/types/events.js';
import type { ChatMessage } from '../../src/types/llm.js';
import { estimateMessagesTokens, estimateTokens } from '../../src/utils/tokens.js';

// ---------------------------------------------------------------------------
// 测试设施
// ---------------------------------------------------------------------------

/** 预留清零、占比 1 → body 预算 = 窗口，让测试只关心裁剪逻辑 */
const tightConfig = (contextWindow: number): ContextManagerConfig => ({
  contextWindow,
  keepRecent: 2,
  outputReserveTokens: 0,
  toolsSystemReserveTokens: 0,
  bodyTargetRatio: 1,
});

const call = (callId: string, path: string): ToolCall => ({
  callId,
  toolName: 'read_file',
  args: { path },
});

// 8 条消息，两个消息组：
//   Q1 组（idx 0-3）：大 user 文本 + 40000 字符 tool_result R1（保留区外）
//   q2 组（idx 4-7）：小 user 文本 + 400 字符 tool_result R2（保留区内）
// keepRecent=2 → 保留区 = {6, 7} ∪ 最后一条 user {4}
const Q1 = 'u'.repeat(4_000); // 1000 est
const R1 = 'a'.repeat(40_000); // 10000 est
const R2 = 'b'.repeat(400); // 100 est

const HISTORY: AgentEvent[] = [
  { type: 'user_input', content: Q1 },
  { type: 'assistant_text', text: '', toolCalls: [call('c1', 'x.txt')] },
  { type: 'tool_call', callId: 'c1', toolName: 'read_file', args: { path: 'x.txt' } },
  { type: 'tool_result', callId: 'c1', ok: true, content: R1, durationMs: 5 },
  { type: 'assistant_text', text: 'a1', toolCalls: [] },
  { type: 'user_input', content: 'q2' },
  { type: 'assistant_text', text: '', toolCalls: [call('c2', 'y.txt')] },
  { type: 'tool_call', callId: 'c2', toolName: 'read_file', args: { path: 'y.txt' } },
  { type: 'tool_result', callId: 'c2', ok: true, content: R2, durationMs: 5 },
  { type: 'assistant_text', text: 'a2', toolCalls: [] },
];

/** push 投影的期望消息（与事件一一对应；tool_call 不产出消息） */
const EXPECTED_MESSAGES: ChatMessage[] = [
  { role: 'user', text: Q1 },
  { role: 'assistant', text: '', toolCalls: [call('c1', 'x.txt')] },
  { role: 'tool', callId: 'c1', text: R1 },
  { role: 'assistant', text: 'a1' },
  { role: 'user', text: 'q2' },
  { role: 'assistant', text: '', toolCalls: [call('c2', 'y.txt')] },
  { role: 'tool', callId: 'c2', text: R2 },
  { role: 'assistant', text: 'a2' },
];

const EST_TOTAL = estimateMessagesTokens(EXPECTED_MESSAGES);
const R1_PLACEHOLDER = toolElidedPlaceholder(R1.length, 'read_file', 'c1');
const R1_PLACEHOLDER_EST = estimateTokens(R1_PLACEHOLDER);
const EST_AFTER_ELIDE = EST_TOTAL - 10_000 + R1_PLACEHOLDER_EST;
const EST_Q2_GROUP = estimateMessagesTokens(EXPECTED_MESSAGES.slice(4));

// ---------------------------------------------------------------------------
// 默认参数与投影
// ---------------------------------------------------------------------------

describe('ContextManager', () => {
  it('默认参数与 body 预算公式', () => {
    expect(DEFAULT_OUTPUT_RESERVE_TOKENS).toBe(4_000);
    expect(DEFAULT_TOOLS_SYSTEM_RESERVE_TOKENS).toBe(8_000);
    expect(DEFAULT_BODY_TARGET_RATIO).toBe(0.8);
    expect(DEFAULT_KEEP_RECENT).toBe(6);

    const manager = new ContextManager({ contextWindow: 100_000 });
    expect(manager.bodyBudgetTokens()).toBe(Math.floor((100_000 - 4_000 - 8_000) * 0.8));
    expect(manager.bodyBudgetTokens()).toBe(70_400);
  });

  it('push 投影：10 个事件 → 8 条消息（tool_call 只登记名称不产出消息）', () => {
    const manager = ContextManager.fromEvents(HISTORY, tightConfig(20_000));
    expect(manager.size).toBe(8);
  });

  it('tool_result ok=false → isError 消息', async () => {
    const events: AgentEvent[] = [
      { type: 'user_input', content: 'q' },
      { type: 'assistant_text', text: '', toolCalls: [call('c8', 'z.txt')] },
      { type: 'tool_result', callId: 'c8', ok: false, content: 'boom', durationMs: 1 },
    ];
    const result = await ContextManager.fromEvents(events, tightConfig(20_000)).build();
    expect(result.messages[2]).toEqual({ role: 'tool', callId: 'c8', text: 'boom', isError: true });
  });

  // -------------------------------------------------------------------------
  // 裁剪分级（§6.5 验收矩阵）
  // -------------------------------------------------------------------------

  it('预算内不裁剪：原样返回全部消息', async () => {
    const result = await ContextManager.fromEvents(HISTORY, tightConfig(20_000)).build();
    expect(result.elidedCount).toBe(0);
    expect(result.freedEstTokens).toBe(0);
    expect(result.estTokens).toBe(EST_TOTAL);
    expect(result.messages).toEqual(EXPECTED_MESSAGES);
  });

  it('阶段 1：超限时仅省略保留区外的 tool_result，达标即停', async () => {
    const result = await ContextManager.fromEvents(HISTORY, tightConfig(5_000)).build();
    expect(result.bodyBudgetTokens).toBe(5_000);
    expect(result.elidedCount).toBe(1);
    expect(result.estTokens).toBe(EST_AFTER_ELIDE);
    expect(result.freedEstTokens).toBe(10_000 - R1_PLACEHOLDER_EST);
    expect(result.messages).toHaveLength(8);
    // 非保留 tool_result 被占位符替换
    expect(result.messages[2]?.text).toBe(R1_PLACEHOLDER);
    // 保留区（R2）与其余消息原样
    expect(result.messages[6]?.text).toBe(R2);
    expect(result.messages[0]?.text).toBe(Q1);
  });

  it('阶段 2：省略后仍超 → 丢弃最早消息组，首条保持 user', async () => {
    const result = await ContextManager.fromEvents(HISTORY, tightConfig(1_000)).build();
    expect(result.elidedCount).toBe(1 + 4); // 1 次省略 + Q1 组 4 条被丢弃
    expect(result.messages).toEqual(EXPECTED_MESSAGES.slice(4));
    expect(result.messages[0]?.role).toBe('user'); // Provider 消息结构约束
    expect(result.estTokens).toBe(EST_Q2_GROUP);
    expect(result.freedEstTokens).toBe(EST_TOTAL - EST_Q2_GROUP);
  });

  it('丢完可丢组仍超 → best-effort 返回，保留区永不丢', async () => {
    const result = await ContextManager.fromEvents(HISTORY, tightConfig(100)).build();
    expect(result.messages).toEqual(EXPECTED_MESSAGES.slice(4));
    expect(result.messages).toHaveLength(4);
    expect(result.messages[2]?.text).toBe(R2); // 保留区 tool_result 原样
    expect(result.elidedCount).toBe(5);
    expect(result.estTokens).toBeGreaterThan(result.bodyBudgetTokens);
  });

  it('占位符不小于原文时跳过省略（省略无益）', async () => {
    const events: AgentEvent[] = [
      { type: 'user_input', content: 'q' },
      { type: 'assistant_text', text: '', toolCalls: [call('c9', 't.txt')] },
      { type: 'tool_result', callId: 'c9', ok: true, content: 'ok', durationMs: 1 },
      { type: 'assistant_text', text: 'a', toolCalls: [] },
    ];
    const result = await ContextManager.fromEvents(events, { ...tightConfig(1), keepRecent: 1 }).build();
    expect(result.elidedCount).toBe(0);
    expect(result.messages[2]?.text).toBe('ok');
    expect(result.estTokens).toBeGreaterThan(result.bodyBudgetTokens); // best-effort
  });

  it('未知 callId 的占位符回退为 unknown', async () => {
    const events: AgentEvent[] = [
      { type: 'user_input', content: 'q' },
      { type: 'tool_result', callId: 'ghost', ok: true, content: 'x'.repeat(400), durationMs: 1 },
    ];
    const result = await ContextManager.fromEvents(events, { ...tightConfig(50), keepRecent: 0 }).build();
    expect(result.elidedCount).toBe(1);
    expect(result.messages[1]?.text).toBe(toolElidedPlaceholder(400, 'unknown', 'ghost'));
  });

  // -------------------------------------------------------------------------
  // 一致性与纯度
  // -------------------------------------------------------------------------

  it('fromEvents 与逐步 push 构建结果一致（resume 等价性）', async () => {
    const folded = ContextManager.fromEvents(HISTORY, tightConfig(1_000));
    const stepped = new ContextManager(tightConfig(1_000));
    for (const event of HISTORY) stepped.push(event);

    expect(stepped.size).toBe(folded.size);
    expect(await stepped.build()).toEqual(await folded.build());
  });

  it('build() 是纯函数：重复调用结果一致（原始消息未被就地改写）', async () => {
    // 窗口 5000 = 仅省略场景，messages[2] 是占位符，可观测原文是否被就地改写
    const manager = ContextManager.fromEvents(HISTORY, tightConfig(5_000));
    const first = await manager.build();
    const second = await manager.build();

    expect(second).toEqual(first);
    expect(second.messages[2]?.text).toBe(R1_PLACEHOLDER);
  });
});
