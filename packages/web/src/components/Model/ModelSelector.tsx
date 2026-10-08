/**
 * 会话模型选择器：列出**当前默认提供商**下的全部可用模型，
 * 选中后只影响当前会话（写回 session.model），不改动全局默认。
 *
 * 无 Web UI provider（例如只配了 .env）时降级为只读展示。
 */
import { useEffect } from 'react';

import { useModelStore } from '../../stores/model.js';

interface ModelSelectorProps {
  /** 当前会话的模型标签（"providerId/modelId"） */
  value: string;
  onChange: (model: string) => void;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps): JSX.Element {
  const providers = useModelStore((s) => s.providers);
  const active = useModelStore((s) => s.active);
  const load = useModelStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  const provider = providers.find((p) => p.id === active.providerId);
  const options = provider === undefined ? [] : provider.models.map((m) => ({ label: m.id, value: `${provider.id}/${m.id}` }));

  // 没有可切换的模型目录（例如只在 .env 里配置）：只读展示当前会话模型
  if (options.length === 0) {
    return (
      <select className="select" value={value} disabled aria-label="会话模型">
        <option value={value}>{value === '' ? '未配置模型' : value}</option>
      </select>
    );
  }

  // 会话正在用的模型可能不在目录里（例如手工写入），仍需可选展示
  const withCurrent = options.some((o) => o.value === value)
    ? options
    : [{ label: value, value }, ...options];

  return (
    <select
      className="select"
      value={value}
      aria-label="会话模型"
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">跟随默认</option>
      {withCurrent.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
