/**
 * 会话选择器（§6.8 `wlyd resume [id]`）：无 id 时弹最近 10 个会话，
 * 上下箭头选择，Enter 确认，q / Escape / Ctrl+C 取消。
 *
 * 纯 ink 组件，不依赖 storage —— 由调用方传入 Session[]，
 * 返回 Promise<Session | undefined>（undefined = 取消）。
 *
 * 设计约束：
 * - 用 ink 的 useInput + useApp，不引入额外 TUI 框架；
 * - 渲染在 ink render 之前独立运行（render → waitUntilExit → unmount），
 *   不影响后续主 App 的 Static 区域；
 * - 列表为空时直接返回 undefined（调用方决定如何提示）。
 */
import { Box, Text, useApp, useInput } from 'ink';
import { useState, type ReactElement } from 'react';

import type { Session } from '../core/ports.js';

export interface SessionPickerProps {
  sessions: Session[];
  onPick: (session: Session | undefined) => void;
}

function formatSession(session: Session, selected: boolean): ReactElement {
  const marker = selected ? '❯ ' : '  ';
  const title = session.title.length > 0 ? session.title : '(untitled)';
  return (
    <Text key={session.id}>
      {marker}
      <Text color="cyan">{session.id.slice(0, 8)}</Text>
      {'  '}
      <Text dimColor>{session.updatedAt.slice(0, 16).replace('T', ' ')}</Text>
      {'  '}
      <Text dimColor>{session.model}</Text>
      {'  '}
      <Text bold={selected}>{title}</Text>
    </Text>
  );
}

export function SessionPicker(props: SessionPickerProps): ReactElement {
  const { sessions, onPick } = props;
  const [cursor, setCursor] = useState(0);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onPick(undefined);
      exit();
      return;
    }
    if (key.upArrow && cursor > 0) {
      setCursor(cursor - 1);
    } else if (key.downArrow && cursor < sessions.length - 1) {
      setCursor(cursor + 1);
    } else if (key.return) {
      const picked = sessions[cursor];
      onPick(picked);
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Select a session to resume (↑↓ navigate, Enter confirm, q/Escape cancel):
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.map((session, index) => formatSession(session, index === cursor))}
      </Box>
    </Box>
  );
}

/**
 * 独立渲染 picker，返回用户选择。
 * 调用方负责在 picker 结束后再 render 主 App。
 */
export async function pickSession(sessions: Session[]): Promise<Session | undefined> {
  if (sessions.length === 0) return undefined;
  // 动态 import render 避免顶层引入 ink 导致非 TUI 场景加载开销
  const { render } = await import('ink');
  return new Promise<Session | undefined>((resolve) => {
    const instance = render(
      <SessionPicker sessions={sessions} onPick={(session) => resolve(session)} />,
    );
    void instance.waitUntilExit().then(() => instance.unmount());
  });
}
