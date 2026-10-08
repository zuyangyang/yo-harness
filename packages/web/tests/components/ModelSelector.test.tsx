/**
 * ModelSelector 测试：只列出当前默认提供商的可用模型，选中后回传会话级标签。
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
  it('列出当前提供商的全部可用模型', () => {
    render(<ModelSelector value="wlyd-llm/deepseek-flash" onChange={vi.fn()} />);

    const select = screen.getByLabelText<HTMLSelectElement>('会话模型');
    expect(select.value).toBe('wlyd-llm/deepseek-flash');
    expect(screen.getByRole('option', { name: 'deepseek-flash' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'deepseek-v4-pro' })).toBeTruthy();
  });

  it('切换后回传带提供商前缀的会话级标签', () => {
    const onChange = vi.fn();
    render(<ModelSelector value="wlyd-llm/deepseek-flash" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('会话模型'), {
      target: { value: 'wlyd-llm/deepseek-v4-pro' },
    });

    expect(onChange).toHaveBeenCalledWith('wlyd-llm/deepseek-v4-pro');
  });

  it('无 Web UI provider 时降级为只读展示', () => {
    useModelStore.setState({ providers: [], active: { providerId: '', model: '' } });
    render(<ModelSelector value="openai-compat/deepseek-chat" onChange={vi.fn()} />);

    const select = screen.getByLabelText<HTMLSelectElement>('会话模型');
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('openai-compat/deepseek-chat');
  });
});
