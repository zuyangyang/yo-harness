/**
 * 审批 UI（§6.8）：approval_request 到达时渲染工具名 + 脱敏摘要，
 * 键入 y / a / n 应答（Enter 视为 y）；应答经 Promise 送回 AgentLoop
 * 的 permission ask，循环在等待期间挂起。
 *
 * AskBridge：运行时必须「先装配 permission、后渲染 React」（装配顺序
 * config → db → stores → gateway → registry → permission → loop → render），
 * 桥对象把装配期的 ask 端口与组件期的 ask 实现接起来 —— UI 未挂载或已
 * 卸载时一律拒绝：宁可保守不可放行。
 */
import { Box, Text, useInput } from 'ink';
import type { ReactElement } from 'react';

import type { ApprovalAnswer, ApprovalAsk, ApprovalRequest } from '../core/permission.js';

export class AskBridge {
  private handler: ApprovalAsk | undefined;

  /** 装配期拿到的 ask 端口；UI 未挂载时保守拒绝 */
  readonly ask: ApprovalAsk = (request) => {
    const handler = this.handler;
    if (handler === undefined) return Promise.resolve('no');
    return handler(request);
  };

  /** App 挂载时注入真正的交互实现 */
  attach(handler: ApprovalAsk): void {
    this.handler = handler;
  }

  /** App 卸载后回到保守拒绝 */
  detach(): void {
    this.handler = undefined;
  }
}

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  onAnswer: (answer: ApprovalAnswer) => void;
}

export function ApprovalPrompt({ request, onAnswer }: ApprovalPromptProps): ReactElement {
  useInput((input, key) => {
    if (key.return) {
      onAnswer('yes');
      return;
    }
    if (input.length !== 1) return;
    const char = input.toLowerCase();
    if (char === 'y') onAnswer('yes');
    else if (char === 'a') onAnswer('always');
    else if (char === 'n') onAnswer('no');
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginY={1}
    >
      <Text color="yellow" bold>
        ⚡ approval required
      </Text>
      <Text color="yellow">{request.toolName}</Text>
      <Text>{request.summary}</Text>
      <Text dimColor>[y] allow once · [a] allow this session · [n] deny (Enter = y)</Text>
    </Box>
  );
}
