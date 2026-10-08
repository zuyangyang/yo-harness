/**
 * ModelsSection 组件测试：渲染来源 / 提供商列表、密钥占位、警告与新增表单。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelsSection } from '../../src/features/settings/model/ModelsSection.js';
import { useModelStore } from '../../src/stores/model.js';

const WLYD = {
  id: 'wlyd',
  displayName: 'wlyd',
  kind: 'openai-compat' as const,
  baseURL: 'https://gateway.test/v1',
  hasKey: true,
  apiKeyHint: 'sk-…efgh',
  models: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }],
  sortOrder: 0,
};

beforeEach(() => {
  useModelStore.setState({
    providers: [WLYD],
    active: { providerId: 'wlyd', model: 'deepseek-v4-pro' },
    source: 'web',
    warnings: [],
    isLoading: false,
    error: null,
    load: vi.fn().mockResolvedValue(undefined),
  });
});

describe('ModelsSection', () => {
  it('渲染生效来源与提供商列表', () => {
    render(<ModelsSection />);

    expect(screen.getByText('默认使用提供商及模型')).toBeTruthy();
    expect(screen.getByText('Web UI 配置')).toBeTruthy();
    // provider 名同时出现在当前模型下拉与卡片标题中
    expect(screen.getAllByText('wlyd').length).toBeGreaterThanOrEqual(1);
  });

  it('当前模型下拉回显已保存选择', () => {
    render(<ModelsSection />);

    const modelSelect = screen.getByLabelText<HTMLSelectElement>('模型');
    expect(modelSelect.value).toBe('deepseek-v4-pro');
  });

  it('显示降级告警', () => {
    useModelStore.setState({ warnings: ['Web UI 中 provider "wlyd" 缺少 API 密钥，已回退'] });
    render(<ModelsSection />);

    expect(screen.getByText(/缺少 API 密钥/)).toBeTruthy();
  });

  it('展开编辑后密钥框为密码类型且提示可替换', () => {
    render(<ModelsSection />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    const keyInput = screen.getByLabelText<HTMLInputElement>('API 密钥');
    expect(keyInput.type).toBe('password');
    expect(keyInput.placeholder).toBe('已配置——输入新值可替换');
  });

  it('新增提供商展开空白表单', () => {
    render(<ModelsSection />);

    fireEvent.click(screen.getByRole('button', { name: '+ 新增提供商' }));

    expect(screen.getByLabelText('标识（ID）')).toBeTruthy();
    expect(screen.getByLabelText('显示名称')).toBeTruthy();
    // 「保存」同时存在于当前模型区与新增卡片
    expect(screen.getAllByRole('button', { name: '保存' }).length).toBeGreaterThanOrEqual(1);
  });
});
