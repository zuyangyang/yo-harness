/**
 * 主界面（§6.8）：上半区事件滚动区（Static，只增不改 → 终端原生滚动），
 * 下半区流式行 + 输入框 + 状态行（model / context 占用% / step / usage）。
 *
 * 关键状态机：
 * - turnActive：runTurn 进行中。期间输入框可输入但提交被拦（提示
 *   Ctrl+C 中断）；`/exit` 与第二次 Ctrl+C 会先 interrupt 再等收尾。
 * - pendingApproval：审批挂起。输入框失焦（TextInput focus），按键
 *   全部路由给 ApprovalPrompt；Ctrl+C 视为拒绝。
 * - SIGINT（exitOnCtrlC: false + raw mode，按键形态 input==='c' && key.ctrl）：
 *   空闲 → 退出；turn 进行中 → interrupt + 提示；2 秒内再按 → 强制退出。
 * - 流式节流（风险 #2）：llm_delta 只进 renderer 缓冲，~50ms 批量刷屏。
 */
import { Box, Static, Text, useApp, useInput, type TextProps } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { AgentLoop } from '../core/agent-loop.js';
import type { AgentStatus, EventBus } from '../core/event-bus.js';
import type { ApprovalAnswer, ApprovalRequest } from '../core/permission.js';
import type { Session } from '../core/ports.js';
import type { EventEnvelope, TurnEndReason } from '../types/events.js';
import { ApprovalPrompt, type AskBridge } from './approval.js';
import { line, type LineStyle, type RenderLine, type RenderModel } from './renderer.js';

const STREAM_FLUSH_MS = 50;
const DOUBLE_CTRL_C_MS = 2000;
const HELP_TEXT = [
  '/help      show this help',
  '/exit      exit (waits for the current turn to wrap up)',
  '/model     show active provider / model',
  '/sessions  list recent sessions',
  '/resume    resume a session (arrives in step 9)',
].join('\n');

export interface AppProps {
  provider: string;
  model: string;
  contextWindow: number;
  bus: EventBus;
  renderer: RenderModel;
  loop: AgentLoop;
  askBridge: AskBridge;
  listSessions: () => Promise<Session[]>;
}

/** exactOptionalPropertyTypes + readonly props：条件展开，避免显式 undefined */
function textStyle(renderLine: RenderLine): TextProps {
  return {
    ...(renderLine.color !== undefined ? { color: renderLine.color } : {}),
    ...(renderLine.bold === true ? { bold: true } : {}),
    ...(renderLine.dim === true ? { dimColor: true } : {}),
  };
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function App(props: AppProps): ReactElement {
  const { provider, model, contextWindow, bus, renderer, loop, askBridge, listSessions } = props;
  const { exit } = useApp();

  const [lines, setLines] = useState<RenderLine[]>([]);
  const [streamText, setStreamText] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [turnActive, setTurnActive] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);

  const resolveApprovalRef = useRef<((answer: ApprovalAnswer) => void) | undefined>(undefined);
  const turnPromiseRef = useRef<Promise<TurnEndReason> | null>(null);
  const lastCtrlCRef = useRef(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const appendLocal = (text: string, style?: LineStyle): void => {
    setLines((prev) => [...prev, line(text, style)]);
  };

  /** 流式节流：delta 只进缓冲，最多每 50ms 刷一次屏 */
  const scheduleStreamFlush = (): void => {
    if (flushTimerRef.current !== undefined) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = undefined;
      setStreamText(renderer.stream);
    }, STREAM_FLUSH_MS);
  };

  // 总线订阅：事件 → renderer → Static 行；delta → 节流缓冲；status → 状态行
  useEffect(() => {
    const onEvent = (envelope: EventEnvelope): void => {
      const newLines = renderer.push(envelope.payload);
      if (newLines.length > 0) setLines((prev) => [...prev, ...newLines]);
      setStreamText(renderer.stream); // assistant_text 提交后缓冲即清空
    };
    const onDelta = (delta: string): void => {
      renderer.pushDelta(delta);
      scheduleStreamFlush();
    };
    const onStatus = (next: AgentStatus): void => {
      setStatus(next);
    };
    bus.on('event', onEvent);
    bus.on('llm_delta', onDelta);
    bus.on('status', onStatus);
    return () => {
      bus.off('event', onEvent);
      bus.off('llm_delta', onDelta);
      bus.off('status', onStatus);
    };
    // bus/renderer 是稳定单例，仅挂载时订阅一次
  }, []);

  // 审批桥：挂载后 UI 才真正"在线"，卸载即回到保守拒绝
  useEffect(() => {
    askBridge.attach((request) =>
      new Promise<ApprovalAnswer>((resolve) => {
        resolveApprovalRef.current = resolve;
        setPendingApproval(request);
      }),
    );
    return () => {
      askBridge.detach();
      if (flushTimerRef.current !== undefined) clearTimeout(flushTimerRef.current);
    };
    // askBridge 是稳定单例，仅挂载时接桥一次
  }, []);

  const answerApproval = (answer: ApprovalAnswer): void => {
    setPendingApproval(null);
    const resolve = resolveApprovalRef.current;
    resolveApprovalRef.current = undefined;
    if (resolve !== undefined) resolve(answer);
  };

  const startTurn = (text: string): void => {
    setTurnActive(true);
    const running = loop.runTurn(text);
    turnPromiseRef.current = running;
    void running
      .catch(() => undefined)
      .finally(() => {
        turnPromiseRef.current = null;
        setTurnActive(false);
      });
  };

  const exitApp = async (): Promise<void> => {
    if (turnActive) {
      loop.interrupt();
      appendLocal('· interrupting current turn…', { dim: true });
      const running = turnPromiseRef.current;
      if (running !== null) await running.catch(() => undefined);
    }
    exit();
  };

  const runCommand = (command: string): void => {
    const name = command.split(/\s+/)[0] ?? '';
    switch (name) {
      case '/help':
        appendLocal(HELP_TEXT, { dim: true });
        return;
      case '/exit':
        void exitApp();
        return;
      case '/model':
        appendLocal(`model: ${provider}/${model} · context ${contextWindow} tokens`, { dim: true });
        return;
      case '/sessions':
        void listSessions().then((sessions) => {
          if (sessions.length === 0) {
            appendLocal('no sessions yet', { dim: true });
            return;
          }
          const rows = sessions
            .map(
              (session) =>
                `${session.updatedAt}  ${session.id.slice(0, 8)}  ${session.model}  ${
                  session.title.length > 0 ? session.title : '(untitled)'
                }`,
            )
            .join('\n');
          appendLocal(rows, { dim: true });
        });
        return;
      case '/resume':
        appendLocal('session resume arrives in step 9 (`yo resume`)', { dim: true });
        return;
      default:
        appendLocal(`unknown command: ${name} — /help lists commands`, { color: 'yellow' });
    }
  };

  const handleSubmit = (value: string): void => {
    const text = value.trim();
    setInputValue('');
    if (text.length === 0) return;
    if (text.startsWith('/')) {
      runCommand(text);
      return;
    }
    if (turnActive) {
      appendLocal('· a turn is already running — Ctrl+C to interrupt, then resend', { dim: true });
      return;
    }
    startTurn(text);
  };

  // SIGINT：raw mode 下 Ctrl+C 以 input==='c' && key.ctrl 到达（exitOnCtrlC: false）
  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    if (pendingApproval !== null) {
      answerApproval('no');
      appendLocal('✗ denied (Ctrl+C)', { dim: true });
      return;
    }
    if (turnActive) {
      const now = Date.now();
      if (now - lastCtrlCRef.current < DOUBLE_CTRL_C_MS) {
        process.exit(0);
      }
      lastCtrlCRef.current = now;
      loop.interrupt();
      appendLocal('· interrupt requested — press Ctrl+C again to force quit', { color: 'yellow' });
      return;
    }
    void exitApp();
  });

  const ctxPct =
    status === null
      ? 0
      : Math.min(100, Math.round((status.estTokens / contextWindow) * 100));

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(renderLine: RenderLine, index: number) => (
          <Text key={index} {...textStyle(renderLine)}>
            {' '.repeat(renderLine.indent ?? 0)}
            {renderLine.text}
          </Text>
        )}
      </Static>

      {streamText.length > 0 ? (
        <Text>
          {streamText}
          <Text dimColor>▍</Text>
        </Text>
      ) : turnActive ? (
        <Text dimColor>· thinking / running tools…</Text>
      ) : null}

      {pendingApproval === null ? (
        <Box>
          <Text color="cyan" bold>
            {turnActive ? '… ' : '❯ '}
          </Text>
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
        </Box>
      ) : (
        <ApprovalPrompt request={pendingApproval} onAnswer={answerApproval} />
      )}

      <Text dimColor>
        {provider}/{model} · ctx {ctxPct}% · step {status?.step ?? 0}/{status?.maxSteps ?? '—'} · in{' '}
        {formatTokens(status?.usage.inputTokens ?? 0)} / out{' '}
        {formatTokens(status?.usage.outputTokens ?? 0)}
        {turnActive ? ' · running' : ''}
      </Text>
    </Box>
  );
}
