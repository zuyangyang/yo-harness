/**
 * Model selector: fetches available models from /api/v1/models.
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type ModelInfo } from '../../api/client.js';

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps): JSX.Element {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadModels = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.models.list();
      setModels(res.models);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  if (isLoading) {
    return <select className="select" disabled><option>Loading...</option></select>;
  }

  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {models.length === 0 && <option value="">No models available</option>}
      {models.map((m) => (
        <option key={`${m.provider}/${m.model}`} value={m.model}>
          {m.model}
        </option>
      ))}
    </select>
  );
}
