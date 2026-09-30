/**
 * 模型目录编辑器（设计文档 §11.1）。
 *
 * 「获取可用模型」由服务端代发请求（避免浏览器 CORS 与密钥外泄）；
 * 「恢复默认模型」只填充内置建议列表，需点保存才持久化。
 */
import { useState } from 'react';

import { Button } from '../../../components/ui/Button.js';
import type { ModelDescriptor, ProviderKind } from '../../../api/client.js';

const DEFAULT_MODELS: Record<ProviderKind, string[]> = {
  'openai-compat': ['deepseek-chat', 'deepseek-reasoner'],
  anthropic: ['claude-sonnet-4-5', 'claude-haiku-3-5'],
};

export interface ModelCatalogEditorProps {
  models: ModelDescriptor[];
  kind: ProviderKind;
  /** 拉取可用模型；失败时抛错，由调用方 toast */
  onFetch: () => Promise<ModelDescriptor[]>;
  onChange: (models: ModelDescriptor[]) => void;
}

export function ModelCatalogEditor({ models, kind, onFetch, onChange }: ModelCatalogEditorProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  const handleFetch = async (): Promise<void> => {
    setBusy(true);
    try {
      const fetched = await onFetch();
      const merged = [...models];
      for (const model of fetched) {
        if (!merged.some((m) => m.id === model.id)) merged.push(model);
      }
      onChange(merged);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = (): void => {
    const next: ModelDescriptor[] = DEFAULT_MODELS[kind].map((id) => ({ id }));
    onChange(next);
  };

  return (
    <div className="model-catalog">
      <div className="model-catalog__head">
        <span className="model-field__label">模型目录</span>
        <div className="model-catalog__actions">
          <Button variant="ghost" size="sm" onClick={handleRestore} disabled={busy}>
            恢复默认模型
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleFetch()} disabled={busy}>
            {busy ? '获取中…' : '获取可用模型'}
          </Button>
        </div>
      </div>

      {models.length === 0 ? (
        <p className="settings-muted">尚未配置模型，可点「获取可用模型」或「恢复默认模型」。</p>
      ) : (
        <ul className="model-catalog__list">
          {models.map((model) => (
            <li key={model.id} className="model-catalog__item">
              <span className="model-catalog__id">{model.id}</span>
              <button
                type="button"
                className="model-catalog__remove"
                aria-label={`删除模型 ${model.id}`}
                onClick={() => onChange(models.filter((m) => m.id !== model.id))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
