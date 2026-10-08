/**
 * 输入框左下角的权限模式选择器：询问审批 / 自动审批 / 完全访问。
 *
 * - 切到「完全访问」需要二次确认（危险模式）；
 * - 组件只负责选择；会话级持久化由父组件 PATCH /sessions/:id 完成。
 */
import { useCallback, useRef, useState } from 'react';

import type { PermissionMode } from '../../api/client.js';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import {
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '../Icons/index.js';

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  description: string;
}

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    value: 'ask',
    label: '询问审批',
    description: '执行命令、修改 Workspace 外文件或访问网络前，始终询问',
  },
  { value: 'auto', label: '自动审批', description: '仅在检测到潜在风险时询问' },
  {
    value: 'full',
    label: '完全访问',
    description: '不再询问，可自由访问你的文件、终端和网络',
  },
];

function ModeIcon({ mode, className }: { mode: PermissionMode; className?: string }): JSX.Element {
  if (mode === 'full') return <ExclamationTriangleIcon className={className} />;
  if (mode === 'auto') return <ArrowPathIcon className={className} />;
  return <InformationCircleIcon className={className} />;
}

interface PermissionModeSelectorProps {
  /** 会话级模式；null = 继承默认 */
  value: PermissionMode | null;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}

export function PermissionModeSelector({
  value,
  onChange,
  disabled = false,
}: PermissionModeSelectorProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const effective: PermissionMode = value ?? 'ask';
  const current =
    PERMISSION_MODE_OPTIONS.find((o) => o.value === effective) ?? PERMISSION_MODE_OPTIONS[0]!;

  const close = useCallback(() => {
    setOpen(false);
    setConfirmFull(false);
  }, []);
  useClickOutside(rootRef, close);

  const choose = (mode: PermissionMode): void => {
    if (mode === 'full' && value !== 'full') {
      setConfirmFull(true);
      return;
    }
    onChange(mode);
    close();
  };

  return (
    <div className="permission-mode" ref={rootRef}>
      <button
        type="button"
        className={`permission-mode__trigger permission-mode__trigger--${effective}`}
        disabled={disabled}
        title={value === null ? '继承默认权限模式' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ModeIcon mode={effective} className="icon-svg permission-mode__icon" />
        <span className="permission-mode__label">{current.label}</span>
        <ChevronDownIcon className="icon-svg permission-mode__chevron" />
      </button>

      {open && (
        <div className="permission-mode__menu" role="listbox" aria-label="权限模式">
          {confirmFull ? (
            <div className="permission-mode__confirm" role="alertdialog" aria-label="确认完全访问">
              <p className="permission-mode__confirm-text">
                完全访问将不再询问，Agent 可读写任意文件、执行任意命令。确认开启？
              </p>
              <div className="permission-mode__confirm-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    onChange('full');
                    close();
                  }}
                >
                  确认开启
                </button>
                <button type="button" className="btn" onClick={() => setConfirmFull(false)}>
                  取消
                </button>
              </div>
            </div>
          ) : (
            PERMISSION_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === effective}
                className={`permission-mode__option permission-mode__option--${option.value}`}
                onClick={() => choose(option.value)}
              >
                <ModeIcon mode={option.value} className="icon-svg permission-mode__option-icon" />
                <span className="permission-mode__option-text">
                  <span className="permission-mode__option-label">{option.label}</span>
                  <span className="permission-mode__option-desc">{option.description}</span>
                </span>
                {option.value === effective && <CheckIcon className="icon-svg permission-mode__check" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
