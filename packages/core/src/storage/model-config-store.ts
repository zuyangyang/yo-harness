/**
 * SQLite 实现：Web UI 模型配置（model_providers / model_settings）。
 *
 * models_json 以 JSON 数组存储；解析失败一律降级为空目录，不阻塞启动。
 */
import type { ModelConfigStore } from '../core/ports.js';
import type { ModelDescriptor, ModelSelection, ProviderRecord, ProviderRecordInput } from '../types/model-config.js';
import type { SqliteDatabase } from './db.js';

const SETTINGS_ROW_ID = 'default';

interface ProviderRow {
  id: string;
  display_name: string;
  kind: string;
  base_url: string | null;
  api_key_cipher: string | null;
  api_key_hint: string | null;
  api_key_env: string | null;
  models_json: string;
  default_context_window: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface SettingsRow {
  active_provider_id: string | null;
  active_model: string | null;
}

/** 解析 models_json：任何异常一律降级为空目录（SQLite / PostgreSQL 共用） */
export function parseModelsJson(json: string): ModelDescriptor[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const models: ModelDescriptor[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string' || id.trim().length === 0) continue;
    const contextWindow = (item as { contextWindow?: unknown }).contextWindow;
    const model: ModelDescriptor = { id: id.trim() };
    if (typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0) {
      model.contextWindow = contextWindow;
    }
    models.push(model);
  }
  return models;
}

function mapProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind === 'anthropic' ? 'anthropic' : 'openai-compat',
    baseURL: row.base_url ?? undefined,
    apiKeyCipher: row.api_key_cipher ?? undefined,
    apiKeyHint: row.api_key_hint ?? undefined,
    apiKeyEnv: row.api_key_env ?? undefined,
    models: parseModelsJson(row.models_json),
    defaultContextWindow: row.default_context_window ?? undefined,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteModelConfigStore implements ModelConfigStore {
  constructor(private readonly db: SqliteDatabase) {}

  async listProviders(): Promise<ProviderRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM model_providers ORDER BY sort_order ASC, created_at ASC')
      .all() as ProviderRow[];
    return rows.map(mapProvider);
  }

  async getProvider(id: string): Promise<ProviderRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM model_providers WHERE id = ?').get(id) as
      | ProviderRow
      | undefined;
    return row === undefined ? undefined : mapProvider(row);
  }

  async upsertProvider(input: ProviderRecordInput): Promise<ProviderRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO model_providers
           (id, display_name, kind, base_url, api_key_cipher, api_key_hint, api_key_env,
            models_json, default_context_window, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           kind = excluded.kind,
           base_url = excluded.base_url,
           api_key_cipher = excluded.api_key_cipher,
           api_key_hint = excluded.api_key_hint,
           api_key_env = excluded.api_key_env,
           models_json = excluded.models_json,
           default_context_window = excluded.default_context_window,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.displayName,
        input.kind,
        input.baseURL ?? null,
        input.apiKeyCipher ?? null,
        input.apiKeyHint ?? null,
        input.apiKeyEnv ?? null,
        JSON.stringify(input.models),
        input.defaultContextWindow ?? null,
        input.sortOrder,
        now,
        now,
      );

    const saved = await this.getProvider(input.id);
    if (saved === undefined) {
      throw new Error(`model provider "${input.id}" disappeared right after upsert`);
    }
    return saved;
  }

  async deleteProvider(id: string): Promise<void> {
    this.db.prepare('DELETE FROM model_providers WHERE id = ?').run(id);
  }

  async getSettings(): Promise<ModelSelection | undefined> {
    const row = this.db.prepare('SELECT * FROM model_settings WHERE id = ?').get(SETTINGS_ROW_ID) as
      | SettingsRow
      | undefined;
    if (row === undefined) return undefined;
    if (row.active_provider_id === null || row.active_model === null) return undefined;
    return { providerId: row.active_provider_id, model: row.active_model };
  }

  async saveSettings(selection: ModelSelection): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO model_settings (id, active_provider_id, active_model, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           active_provider_id = excluded.active_provider_id,
           active_model = excluded.active_model,
           updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_ROW_ID, selection.providerId, selection.model, new Date().toISOString());
  }

  async clearSettings(): Promise<void> {
    this.db.prepare('DELETE FROM model_settings WHERE id = ?').run(SETTINGS_ROW_ID);
  }
}
