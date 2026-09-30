/**
 * Provider 卡片：折叠态显示名称与状态点，展开态编辑密钥 / 自定义设置 / 模型目录。
 *
 * 密钥输入框永不回填真实值：已配置时 placeholder 提示「输入新值可替换」。
 */
import { useState } from 'react';

import { Button } from '../../../components/ui/Button.js';
import { toast } from '../../../stores/toast.js';
import { useModelStore } from '../../../stores/model.js';
import type {
  DiscoverModelsInput,
  ModelDescriptor,
  ProviderKind,
  ProviderProfile,
} from '../../../api/client.js';
import { ModelCatalogEditor } from './ModelCatalogEditor.js';

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface ProviderCardProps {
  /** 缺省 = 新增 */
  profile?: ProviderProfile | undefined;
  onClose?: () => void;
}

export function ProviderCard({ profile, onClose }: ProviderCardProps): JSX.Element {
  const isNew = profile === undefined;
  const [expanded, setExpanded] = useState(isNew);
  const [id, setId] = useState(profile?.id ?? '');
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [kind, setKind] = useState<ProviderKind>(profile?.kind ?? 'openai-compat');
  const [baseURL, setBaseURL] = useState(profile?.baseURL ?? '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelDescriptor[]>(profile?.models ?? []);
  const [busy, setBusy] = useState(false);

  const saveProvider = useModelStore((s) => s.saveProvider);
  const deleteProvider = useModelStore((s) => s.deleteProvider);
  const discover = useModelStore((s) => s.discover);

  const effectiveId = isNew ? (id.trim() === '' ? slugify(displayName) : id.trim()) : profile.id;

  const handleSave = async (): Promise<void> => {
    if (effectiveId === '') {
      toast.warning('请填写显示名称或标识（ID，需为字母/数字/短横线）');
      return;
    }
    setBusy(true);
    try {
      const input = {
        kind,
        displayName: displayName.trim() === '' ? effectiveId : displayName.trim(),
        baseURL: baseURL.trim(),
        models,
      };
      await saveProvider(effectiveId, apiKey.trim() === '' ? input : { ...input, apiKey: apiKey.trim() });
      setApiKey('');
      toast.success('已保存');
      if (isNew) onClose?.();
      else setExpanded(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (profile === undefined) return;
    if (!window.confirm(`确定删除提供商「${profile.displayName}」？`)) return;
    setBusy(true);
    try {
      await deleteProvider(profile.id);
      toast.success('已删除');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const handleFetchModels = async (): Promise<ModelDescriptor[]> => {
    try {
      // 已有 provider 用库存凭据；新建时用当前表单的临时值试连
      if (!isNew) {
        const req: DiscoverModelsInput = { providerId: profile.id, kind, baseURL: baseURL.trim() };
        return await discover(req);
      }
      if (apiKey.trim() !== '') {
        return await discover({ kind, baseURL: baseURL.trim(), apiKey: apiKey.trim() });
      }
      return await discover({ kind, baseURL: baseURL.trim() });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '获取可用模型失败');
      throw err;
    }
  };

  return (
    <div className="model-card">
      <div className="model-card__head">
        <div className="model-card__title">
          <span className={profile?.hasKey === true ? 'model-dot model-dot--on' : 'model-dot'} />
          <span className="model-card__name">{profile?.displayName ?? (displayName || '新增提供商')}</span>
          {isNew ? <span className="model-badge">自定义</span> : null}
        </div>
        <div className="model-card__actions">
          {isNew ? (
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              取消
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '收起' : '编辑'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void handleDelete()} disabled={busy}>
                删除
              </Button>
            </>
          )}
        </div>
      </div>

      {expanded ? (
        <div className="model-card__body">
          {isNew ? (
            <label className="model-field">
              <span className="model-field__label">标识（ID）</span>
              <input
                className="model-input"
                value={id}
                placeholder={slugify(displayName) || '例如 wlyd'}
                onChange={(e) => setId(e.target.value)}
              />
            </label>
          ) : null}

          <label className="model-field">
            <span className="model-field__label">API 密钥</span>
            <input
              className="model-input"
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={profile?.hasKey === true ? '已配置——输入新值可替换' : '粘贴 API 密钥'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>

          <details className="model-advanced" open>
            <summary>自定义设置</summary>

            <label className="model-field">
              <span className="model-field__label">显示名称</span>
              <input className="model-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>

            <label className="model-field">
              <span className="model-field__label">API 地址</span>
              <input
                className="model-input"
                value={baseURL}
                placeholder="https://gateway.example.com/v1"
                onChange={(e) => setBaseURL(e.target.value)}
              />
            </label>

            <label className="model-field">
              <span className="model-field__label">API 协议</span>
              <select
                className="model-input"
                value={kind}
                onChange={(e) => setKind(e.target.value === 'anthropic' ? 'anthropic' : 'openai-compat')}
              >
                <option value="openai-compat">OpenAI Chat Completions</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
          </details>

          <ModelCatalogEditor models={models} kind={kind} onFetch={handleFetchModels} onChange={setModels} />

          <div className="model-card__footer">
            <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={busy}>
              保存
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
