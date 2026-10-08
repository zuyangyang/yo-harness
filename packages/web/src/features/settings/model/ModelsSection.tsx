/**
 * 「设置 → 模型」分区（设计文档 §11.1）。
 *
 * 结构：当前使用的模型 + 提供商卡片列表（新增/编辑/删除）。
 * 数据来自 model store；密钥从不进入本地状态。
 */
import { useEffect, useState } from 'react';

import { Button } from '../../../components/ui/Button.js';
import { useModelStore } from '../../../stores/model.js';
import { toast } from '../../../stores/toast.js';
import type { ConfigSource } from '../../../api/client.js';
import { ProviderCard } from './ProviderCard.js';

const SOURCE_LABEL: Record<ConfigSource, string> = {
  web: 'Web UI 配置',
  env: '.env / 环境变量',
  file: 'config.json',
  default: '内置默认',
};

export function ModelsSection(): JSX.Element {
  const providers = useModelStore((s) => s.providers);
  const active = useModelStore((s) => s.active);
  const source = useModelStore((s) => s.source);
  const warnings = useModelStore((s) => s.warnings);
  const isLoading = useModelStore((s) => s.isLoading);
  const error = useModelStore((s) => s.error);
  const load = useModelStore((s) => s.load);
  const saveActive = useModelStore((s) => s.saveActive);

  const [creating, setCreating] = useState(false);
  const [draftProvider, setDraftProvider] = useState(active.providerId);
  const [draftModel, setDraftModel] = useState(active.model);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setDraftProvider(active.providerId);
    setDraftModel(active.model);
  }, [active]);

  const selected = providers.find((p) => p.id === draftProvider);
  const modelOptions = selected?.models ?? [];

  const handleProviderChange = (providerId: string): void => {
    setDraftProvider(providerId);
    const next = providers.find((p) => p.id === providerId);
    setDraftModel(next?.models[0]?.id ?? '');
  };

  const handleSaveActive = async (): Promise<void> => {
    if (draftProvider === '' || draftModel === '') {
      toast.warning('请先选择提供商与模型');
      return;
    }
    setSaving(true);
    try {
      await saveActive({ providerId: draftProvider, model: draftModel });
      toast.success('已保存当前模型');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2 className="settings-heading">模型</h2>
      <p className="settings-muted">
        填入各提供商的 API 密钥即可使用其模型。当前生效配置来源：
        <span className="model-source">{SOURCE_LABEL[source]}</span>
      </p>

      {warnings.length > 0 ? (
        <div className="model-warning" role="status">
          {warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      {error !== null ? (
        <div className="model-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="settings-section">
        <h3 className="settings-section__title">默认使用提供商及模型</h3>
        <div className="model-active">
          <select
            className="model-input"
            aria-label="提供商"
            value={draftProvider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            <option value="">（未选择）</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>

          <select
            className="model-input"
            aria-label="模型"
            value={draftModel}
            onChange={(e) => setDraftModel(e.target.value)}
          >
            <option value="">（未选择）</option>
            {modelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>

          <Button variant="primary" size="sm" onClick={() => void handleSaveActive()} disabled={saving}>
            保存
          </Button>
        </div>
      </section>

      <section className="settings-section">
        <div className="model-list-head">
          <h3 className="settings-section__title">提供商</h3>
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)} disabled={creating}>
            + 新增提供商
          </Button>
        </div>

        {isLoading && providers.length === 0 ? <p className="settings-muted">加载中…</p> : null}

        {creating ? <ProviderCard onClose={() => setCreating(false)} /> : null}

        {providers.map((provider) => (
          <ProviderCard key={provider.id} profile={provider} />
        ))}

        {!isLoading && !creating && providers.length === 0 ? (
          <p className="settings-muted">尚未配置提供商，当前沿用 .env 中的设置。</p>
        ) : null}
      </section>
    </>
  );
}
