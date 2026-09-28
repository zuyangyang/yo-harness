import { describe, expect, it } from 'vitest';

import type { AgentEvent, TurnEndReason, Usage } from '@yo-harness/core/types/events.js';
import { RenderModel } from '../../src/cli/renderer.js';

const USAGE: Usage = { inputTokens: 12, outputTokens: 34 };

function completed(reason: TurnEndReason, usage: Usage = USAGE): AgentEvent {
  return { type: 'turn_completed', turnId: 't1', reason, usage };
}

describe('RenderModel', () => {
  it('session_started → dim 单行，含 model 与 cwd', () => {
    const lines = new RenderModel().push({ type: 'session_started', model: 'claude-sonnet-4-5', cwd: '/tmp/demo' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: '● session · claude-sonnet-4-5 · /tmp/demo', dim: true });
  });

  it('user_input → 青色加粗、❯ 前缀', () => {
    const lines = new RenderModel().push({ type: 'user_input', content: '帮我看看这个目录' });

    expect(lines[0]).toMatchObject({ text: '❯ 帮我看看这个目录', color: 'cyan', bold: true });
  });

  it('assistant_text 提交文本行并清空流式缓冲', () => {
    const model = new RenderModel();
    model.pushDelta('Hel');
    model.pushDelta('lo');
    expect(model.stream).toBe('Hello');

    const lines = model.push({ type: 'assistant_text', text: 'Hello', toolCalls: [] });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ text: 'Hello' });
    expect(model.stream).toBe('');
  });

  it('assistant_text 空文本（纯工具调用）不产生行；回放场景同样输出全文', () => {
    const model = new RenderModel();
    expect(model.push({ type: 'assistant_text', text: '', toolCalls: [] })).toEqual([]);

    // 无流式（回放 / fake provider）时直接出全文行
    const lines = model.push({ type: 'assistant_text', text: 'final answer', toolCalls: [] });
    expect(lines).toEqual([{ text: 'final answer' }]);
  });

  it('tool_call 记录 callId 摘要 → dim 缩进行', () => {
    const model = new RenderModel();
    const lines = model.push({
      type: 'tool_call',
      callId: 'c1',
      toolName: 'write_file',
      args: { path: 'src/a.ts', content: 'x'.repeat(12) },
    });

    expect(lines[0]).toMatchObject({ text: '→ write_file src/a.ts (12 chars)', dim: true, indent: 2 });
  });

  it('tool_result ok → 绿色 ✓ + callId 关联的摘要 + 时长', () => {
    const model = new RenderModel();
    model.push({ type: 'tool_call', callId: 'c1', toolName: 'shell', args: { command: 'npm test' } });

    const lines = model.push({ type: 'tool_result', callId: 'c1', ok: true, content: 'ok', durationMs: 45 });

    expect(lines[0]).toMatchObject({ text: '✓ npm test · 45ms', color: 'green', indent: 2 });
  });

  it('tool_result 失败 → 红色 ✗ + 单行截断的内容预览；时长超 1s 用秒', () => {
    const model = new RenderModel();
    model.push({ type: 'tool_call', callId: 'c9', toolName: 'shell', args: { command: 'npm run boom' } });

    const lines = model.push({
      type: 'tool_result',
      callId: 'c9',
      ok: false,
      content: `line one\nline two\n${'x'.repeat(200)}`,
      durationMs: 1300,
    });

    expect(lines[0]?.color).toBe('red');
    expect(lines[0]?.text).toContain('✗ npm run boom · 1.3s — line one line two');
    expect(lines[0]?.text).toContain('…');
    expect(lines[0]?.text).not.toContain('\n');
  });

  it('tool_result 未知 callId（防御）→ 退化为 #callId，不崩溃', () => {
    const lines = new RenderModel().push({
      type: 'tool_result',
      callId: 'ghost',
      ok: true,
      content: '',
      durationMs: 1,
    });

    expect(lines[0]?.text).toBe('✓ #ghost · 1ms');
  });

  it('approval_request 黄色问询；approval_result approved/denied 两态', () => {
    const model = new RenderModel();

    const ask = model.push({ type: 'approval_request', callId: 'c1', toolName: 'shell', summary: 'npm install' });
    expect(ask[0]).toMatchObject({ text: '? approval needed: npm install', color: 'yellow', indent: 2 });

    const yes = model.push({ type: 'approval_result', callId: 'c1', approved: true, scope: 'session' });
    expect(yes[0]).toMatchObject({ text: '✓ approved (session)', color: 'green', dim: true, indent: 2 });

    const no = model.push({ type: 'approval_result', callId: 'c1', approved: false, scope: 'once' });
    expect(no[0]).toMatchObject({ text: '✗ denied', color: 'red', dim: true, indent: 2 });
  });

  it('context_elided → dim 提示行', () => {
    const lines = new RenderModel().push({ type: 'context_elided', count: 3, freedEstTokens: 1200 });

    expect(lines[0]).toMatchObject({
      text: '⋯ context trimmed: 3 events, ~1200 tokens freed',
      dim: true,
    });
  });

  it('error → 红色，含 stage 与 recoverable 标记', () => {
    const lines = new RenderModel().push({
      type: 'error',
      stage: 'llm',
      message: 'script exhausted',
      recoverable: false,
    });

    expect(lines[0]).toMatchObject({
      text: '✗ error [llm]: script exhausted',
      color: 'red',
    });

    const recoverable = new RenderModel().push({
      type: 'error',
      stage: 'loop',
      message: 'flux',
      recoverable: true,
    });
    expect(recoverable[0]?.text).toContain('(recoverable)');
  });

  it('turn_completed：done 与中断各有措辞，usage 带出', () => {
    expect(new RenderModel().push(completed('done'))[0]).toMatchObject({
      text: '· turn done · in 12 / out 34',
      dim: true,
    });
    expect(new RenderModel().push(completed('interrupted'))[0]).toMatchObject({
      text: '· turn ended: interrupted · in 12 / out 34',
      dim: true,
    });
  });

  it('turn_started 不产生行（避免噪音）', () => {
    expect(new RenderModel().push({ type: 'turn_started', turnId: 't1' })).toEqual([]);
  });
});
