/**
 * 远程模式运行时：通过 RemoteClient 连接 yo-server，
 * 使用 Ink TUI 渲染事件流、处理用户输入和审批。
 */
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { EventEnvelope } from '@yo-harness/core/types/events.js';
import { FatalError } from '@yo-harness/core/types/errors.js';
import { RemoteClient, type ApprovalRequest } from '../remote-client.js';
import { line, RenderModel, type LineStyle, type RenderLine, type RenderColor } from './renderer.js';

export interface RemoteOptions {
  serverUrl: string;
  tenantId: string;
  username: string;
  password: string;
  model?: string;
  print?: string;
}

export async function runRemote(options: RemoteOptions): Promise<void> {
  if (!options.tenantId || !options.username || !options.password) {
    throw new FatalError(
      '远程模式需要认证信息。请提供 --tenant / --username / --password 或设置 YO_TENANT_ID / YO_USERNAME / YO_PASSWORD 环境变量。',
    );
  }

  const client = new RemoteClient({
    serverUrl: options.serverUrl,
    tenantId: options.tenantId,
    username: options.username,
    password: options.password,
  });

  await client.login();

  const session = await client.createSession(options.model, process.cwd());

  if (options.print !== undefined) {
    await runPrintMode(client, session.id, options.print);
    return;
  }

  await runInteractiveMode(client, session.id);
}

async function runPrintMode(client: RemoteClient, sessionId: string, message: string): Promise<void> {
  client.connectWebSocket();
  client.subscribe(sessionId);

  const events: EventEnvelope[] = [];
  const done = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 5 * 60 * 1000);
    client.on('event', (_sid, envelope) => {
      events.push(envelope);
      if (envelope.payload.type === 'turn_completed') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  await client.sendMessage(sessionId, message);
  await done;

  for (const env of events) {
    if (env.payload.type === 'assistant_text') {
      process.stdout.write(env.payload.text + '\n');
    }
  }

  client.disconnect();
}

async function runInteractiveMode(client: RemoteClient, sessionId: string): Promise<void> {
  const { default: React } = await import('react');
  const { render } = await import('ink');

  client.connectWebSocket();
  client.subscribe(sessionId);

  await new Promise<void>((resolve) => {
    render(
      React.createElement(RemoteApp, { client, sessionId, onExit: resolve }),
      { exitOnCtrlC: false },
    );
  });

  client.disconnect();
}

interface RemoteAppProps {
  client: RemoteClient;
  sessionId: string;
  onExit: () => void;
}

function RemoteApp(props: RemoteAppProps): ReactElement {
  const { client, sessionId, onExit } = props;
  const { exit } = useApp();
  const renderer = useRef(new RenderModel());
  const [lines, setLines] = useState<RenderLine[]>([line(`connected to server · session ${sessionId.slice(0, 8)}`, { dim: true })]);
  const [streamText, setStreamText] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [turnActive, setTurnActive] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const lastCtrlCRef = useRef(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const appendLine = (text: string, style?: LineStyle): void => {
    setLines((prev) => [...prev, line(text, style)]);
  };

  const scheduleFlush = (): void => {
    if (flushTimerRef.current !== undefined) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = undefined;
      setStreamText(renderer.current.stream);
    }, 50);
  };

  useEffect(() => {
    const onEvent = (_sid: string, envelope: EventEnvelope): void => {
      const payload = envelope.payload;
      const newLines = renderer.current.push(payload);
      if (newLines.length > 0) setLines((prev) => [...prev, ...newLines]);
      setStreamText(renderer.current.stream);

      if (payload.type === 'turn_started') {
        setTurnActive(true);
      } else if (payload.type === 'turn_completed') {
        setTurnActive(false);
      }
    };

    const onApproval = (req: ApprovalRequest): void => {
      setPendingApproval(req);
    };

    const onDisconnected = (): void => {
      appendLine('disconnected from server', { color: 'red' as RenderColor });
    };

    client.on('event', onEvent);
    client.on('approval', onApproval);
    client.on('disconnected', onDisconnected);

    return () => {
      client.off('event', onEvent);
      client.off('approval', onApproval);
      client.off('disconnected', onDisconnected);
      if (flushTimerRef.current !== undefined) clearTimeout(flushTimerRef.current);
    };
  }, []);

  const handleSubmit = (value: string): void => {
    const text = value.trim();
    setInputValue('');
    if (text.length === 0) return;
    if (text === '/exit') {
      void doExit();
      return;
    }
    if (text === '/help') {
      appendLine('/help — show help\n/exit — exit', { dim: true });
      return;
    }
    if (turnActive) {
      appendLine('a turn is running — wait or Ctrl+C to interrupt', { dim: true });
      return;
    }
    appendLine(`❯ ${text}`, { color: 'cyan' as RenderColor });
    setTurnActive(true);
    void client.sendMessage(sessionId, text).catch((err) => {
      appendLine(`send failed: ${String(err)}`, { color: 'red' as RenderColor });
      setTurnActive(false);
    });
  };

  const handleApproval = (approved: boolean): void => {
    if (pendingApproval === null) return;
    void client.resolveApproval(pendingApproval.approvalId, approved).catch((err) => {
      appendLine(`approval failed: ${String(err)}`, { color: 'red' as RenderColor });
    });
    setPendingApproval(null);
  };

  const doExit = async (): Promise<void> => {
    if (turnActive) {
      await client.interrupt(sessionId).catch(() => undefined);
    }
    exit();
    onExit();
  };

  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    if (pendingApproval !== null) {
      handleApproval(false);
      appendLine('denied (Ctrl+C)', { dim: true });
      return;
    }
    if (turnActive) {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 2000) {
        process.exit(0);
      }
      lastCtrlCRef.current = now;
      void client.interrupt(sessionId).catch(() => undefined);
      appendLine('interrupt requested — Ctrl+C again to force quit', { color: 'yellow' as RenderColor });
      return;
    }
    void doExit();
  });

  const textStyle = (rl: RenderLine): Record<string, unknown> => ({
    ...(rl.color !== undefined ? { color: rl.color } : {}),
    ...(rl.bold === true ? { bold: true } : {}),
    ...(rl.dim === true ? { dimColor: true } : {}),
  });

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(rl: RenderLine, i: number) => (
          <Text key={i} {...textStyle(rl)}>
            {' '.repeat(rl.indent ?? 0)}
            {rl.text}
          </Text>
        )}
      </Static>

      {streamText.length > 0 ? (
        <Text>
          {streamText}
          <Text dimColor>▍</Text>
        </Text>
      ) : turnActive ? (
        <Text dimColor>running...</Text>
      ) : null}

      {pendingApproval === null ? (
        <Box>
          <Text color="cyan" bold>
            {turnActive ? '… ' : '❯ '}
          </Text>
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="yellow" bold>
            approval required: {pendingApproval.toolName}
          </Text>
          <Text dimColor>{pendingApproval.summary}</Text>
          <Text>
            <Text color="green">[y]</Text> approve{'  '}
            <Text color="red">[n]</Text> deny
          </Text>
          <ApprovalInput onAnswer={handleApproval} />
        </Box>
      )}
    </Box>
  );
}

function ApprovalInput({ onAnswer }: { onAnswer: (approved: boolean) => void }): ReactElement {
  const [value, setValue] = useState('');

  const handleSubmit = (v: string): void => {
    const trimmed = v.trim().toLowerCase();
    if (trimmed === 'y' || trimmed === 'yes') {
      onAnswer(true);
    } else {
      onAnswer(false);
    }
  };

  return (
    <Box>
      <Text>{'> '}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
    </Box>
  );
}
