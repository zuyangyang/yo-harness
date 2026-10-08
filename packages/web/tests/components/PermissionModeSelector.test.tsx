/**
 * PermissionModeSelector：三级权限模式选择 + 完全访问二次确认。
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionModeSelector } from '../../src/components/Permissions/PermissionModeSelector.js';

describe('PermissionModeSelector', () => {
  it('value=null 时显示继承的询问审批', () => {
    render(<PermissionModeSelector value={null} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /询问审批/ })).toBeTruthy();
  });

  it('选择自动审批 → onChange(auto)', () => {
    const onChange = vi.fn();
    render(<PermissionModeSelector value="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /询问审批/ }));
    fireEvent.click(screen.getByRole('option', { name: /自动审批/ }));
    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('选择完全访问需二次确认后才 onChange(full)', () => {
    const onChange = vi.fn();
    render(<PermissionModeSelector value="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /询问审批/ }));
    fireEvent.click(screen.getByRole('option', { name: /完全访问/ }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认开启' }));
    expect(onChange).toHaveBeenCalledWith('full');
  });

  it('二次确认取消 → 不切换', () => {
    const onChange = vi.fn();
    render(<PermissionModeSelector value="ask" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /询问审批/ }));
    fireEvent.click(screen.getByRole('option', { name: /完全访问/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
