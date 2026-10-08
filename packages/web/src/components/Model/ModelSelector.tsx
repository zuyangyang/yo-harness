/**
 * 会话模型选择器（自定义下拉，替代观感不佳的原生 <select>）。
 *
 * 只列出**当前默认提供商**下的全部可用模型；选中后只影响当前会话
 * （写回 session.model），选「跟随默认」则清空会话级覆盖。
 * 没有可切换的模型目录（例如只配了 .env）时降级为只读展示。
 */
import { useEffect, useRef, useState } from 'react';

import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useModelStore } from '../../stores/model.js';
import { CheckIcon, ChevronDownIcon, CpuChipIcon } from '../Icons/index.js';

interface ModelSelectorProps {
  /** 当前会话的模型标签（"providerId/modelId"）；空串 = 跟随默认 */
  value: string;
  onChange: (model: string) => void;
}

interface PickerOption {
  label: string;
  value: string;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps): JSX.Element {
  const providers = useModelStore((s) => s.providers);
  const active = useModelStore((s) => s.active);
  const load = useModelStore((s) => s.load);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(rootRef, () => setOpen(false));

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const provider = providers.find((p) => p.id === active.providerId);
  const options: PickerOption[] =
    provider === undefined
      ? []
      : [
          { label: '跟随默认', value: '' },
          ...provider.models.map((m) => ({ label: m.id, value: `${provider.id}/${m.id}` })),
        ];
  const selectable = options.length > 0;

  const slash = value.indexOf('/');
  const currentLabel = value === '' ? '跟随默认' : slash >= 0 ? value.slice(slash + 1) : value;

  const handleSelect = (next: string): void => {
    setOpen(false);
    if (next !== value) onChange(next);
  };

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className={'model-picker__trigger' + (open ? ' model-picker__trigger--open' : '')}
        onClick={() => {
          if (selectable) setOpen((v) => !v);
        }}
        disabled={!selectable}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="会话模型"
        title={value === '' ? '跟随默认模型' : value}
      >
        <CpuChipIcon className="model-picker__icon" />
        <span className="model-picker__label">{currentLabel}</span>
        <ChevronDownIcon className="model-picker__chevron" />
      </button>

      {open && selectable ? (
        <div className="model-picker__menu" role="listbox" aria-label="会话模型">
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value === '' ? '__default' : option.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={'model-picker__item' + (selected ? ' model-picker__item--selected' : '')}
                onClick={() => handleSelect(option.value)}
              >
                <span className="model-picker__check">
                  {selected ? <CheckIcon className="model-picker__check-icon" /> : null}
                </span>
                <span className="model-picker__item-label">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
