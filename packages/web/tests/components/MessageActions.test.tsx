/**
 * MessageActions / TurnBlock：复制、重新生成、编辑重发的交互接线。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageActions } from '../../src/components/Chat/MessageActions.js';
import { TurnBlock } from '../../src/components/Chat/TurnBlock.js';
import { useToastStore } from '../../src/stores/toast.js';
import type { Turn } from '../../src/utils/turn-grouping.js';

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-0',
    userInputSeq: 2,
    userMessage: '原问题',
    thinkingTexts: [],
    toolSteps: [],
    finalText: '回答',
    errors: [],
    meta: [],
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('MessageActions', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.restoreAllMocks();
  });

  it('复制按钮把文本写入剪贴板并提示成功', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<MessageActions text="hello" />);
    fireEvent.click(screen.getByRole('button', { name: '复制' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('hello'));
    expect(useToastStore.getState().toasts.at(-1)?.type).toBe('success');
  });

  it('点击重新生成触发 onRetry', () => {
    const onRetry = vi.fn();
    render(<MessageActions text="x" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('未提供回调时不渲染重新生成 / 编辑按钮', () => {
    render(<MessageActions text="x" />);
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });
});

describe('TurnBlock 编辑重发', () => {
  it('点击编辑进入编辑态，保存时以新内容调用 onEdit 并退出编辑态', async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    render(<TurnBlock turn={makeTurn()} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('编辑消息');
    expect(textarea.value).toBe('原问题');

    fireEvent.change(textarea, { target: { value: '新问题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并重新发送' }));

    await waitFor(() => expect(onEdit).toHaveBeenCalledWith('新问题'));
    await waitFor(() => expect(screen.queryByLabelText('编辑消息')).toBeNull());
  });

  it('onEdit 失败时保留编辑态，避免输入丢失', async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error('boom'));
    render(<TurnBlock turn={makeTurn()} onEdit={onEdit} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '保存并重新发送' }));

    await waitFor(() => expect(onEdit).toHaveBeenCalled());
    expect(screen.getByLabelText('编辑消息')).toBeTruthy();
  });

  it('点击重新生成调用 onRetry', () => {
    const onRetry = vi.fn();
    render(<TurnBlock turn={makeTurn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
