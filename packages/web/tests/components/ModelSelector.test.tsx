/**
 * ModelSelector 测试：自定义下拉只列当前提供商的可用模型，
 * 选中回传会话级标签，「跟随默认」回传空串。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelSelector } from '../../src/components/Model/ModelSelector.js';
import { useModelStore } from '../../src/stores/model.js';
import type { ProviderProfile } from '../../src/api/client.js';

const PROVIDER: ProviderProfile = {
  id: 'wlyd-llm',
  displayName: 'wlyd-llm',
  kind: 'openai-compat',
  baseURL: 'https://gateway.test/v1',
  hasKey: true,
  apiKeyHint: 'sk-…efgh',
  models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
  sortOrder: 0,
};

beforeEach(() => {
  useModelStore.setState({
    providers: [PROVIDER],
    active: { providerId: 'wlyd-llm', model: 'deepseek-flash' },
    source: 'web',
    warnings: [],
    isLoading: false,
    error: null,
    load: vi.fn().mockResolvedValue(undefined),
  });
});

describe('ModelSelector', () => {
  it('触发器只显示模型名，不显示 providerId 前缀', () => {
    render(<ModelSelector value="wlyd-llm/deepseek-v4-pro" onChange={vi.fn()} />);

    const trigger = screen.getByLabelText('会话模型');
    expect(trigger.textContent).toContain('deepseek-v4-pro');
    expect(trigger.textContent).not.toContain('wlyd-llm/');
  });

  it('展开后列出「跟随默认」与全部可用模型', () => {
    render(<ModelSelector value="wlyd-llm/deepseek-flash" onChange={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('会话模型'));

    expect(screen.getByRole('option', { name: /跟随默认/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'deepseek-flash' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'deepseek-v4-pro' })).toBeTruthy();
  });

  it('选中模型回传带提供商前缀的会话级标签', () => {
    const onChange = vi.fn();
    render(<ModelSelector value="wlyd-llm/deepseek-flash" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('会话模型'));
    fireEvent.click(screen.getByRole('option', { name: 'deepseek-v4-pro' }));

    expect(onChange).toHaveBeenCalledWith('wlyd-llm/deepseek-v4-pro');
  });

  it('「跟随默认」回传空串（清空会话级覆盖）', () => {
    const onChange = vi.fn();
    render(<ModelSelector value="wlyd-llm/deepseek-v4-pro" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('会话模型'));
    fireEvent.click(screen.getByRole('option', { name: /跟随默认/ }));

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('无 Web UI provider 时触发器只读', () => {
    useModelStore.setState({ providers: [], active: { providerId: '', model: '' } });
    render(<ModelSelector value="openai-compat/deepseek-chat" onChange={vi.fn()} />);

    const trigger = screen.getByLabelText<HTMLButtonElement>('会话模型');
    expect(trigger.disabled).toBe(true);
    expect(trigger.textContent).toContain('deepseek-chat');
  });
});
