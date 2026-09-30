import { useEffect, useRef, useState } from 'react';

import { XMarkIcon } from '../Icons/index.js';

interface WorkspaceDialogProps {
  title: string;
  submitLabel: string;
  initialName?: string;
  onSubmit: (name: string) => Promise<void> | void;
  onClose: () => void;
}

export function WorkspaceDialog({
  title,
  submitLabel,
  initialName = '',
  onSubmit,
  onClose,
}: WorkspaceDialogProps): JSX.Element {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = name.trim();
  const canSubmit = trimmed !== '' && !submitting;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="workspace-dialog-overlay" onClick={onClose}>
      <div
        className="workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="workspace-dialog__header">
          <h3 className="workspace-dialog__title">{title}</h3>
          <button className="workspace-dialog__close" onClick={onClose} aria-label="关闭">
            <XMarkIcon className="icon-svg" />
          </button>
        </div>
        <form
          className="workspace-dialog__body"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <label className="workspace-dialog__label" htmlFor="workspace-name">
            工作区名称
          </label>
          <input
            id="workspace-name"
            ref={inputRef}
            className="workspace-dialog__input"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：工作 / 学习 / 个人项目"
            aria-label="工作区名称"
          />
          <div className="workspace-dialog__actions">
            <button type="button" className="ui-btn ui-btn--md" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="ui-btn ui-btn--md ui-btn--primary" disabled={!canSubmit}>
              {submitting ? '保存中…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
