/**
 * 模型配置服务（设计文档 docs/MODEL-CONFIG-DESIGN.md §8）。
 *
 * 职责：
 * - 把持久化的 Provider 档案 + 当前选择，按 §4 优先级解析为生效配置；
 * - 组装 LLMClient / LLMGateway / ModelRouter，供 SessionManager 使用；
 * - Provider 增删改、当前选择保存、可用模型自动发现；
 * - 配置变更后重建运行时并回调 onChange（由装配层通知 SessionManager 失效）。
 *
 * 安全：明文密钥只在「写入时加密」「解析时解密」两个瞬间存在，
 * 绝不进入返回值（ProviderProfile 只带掩码）、日志或事件。
 */
import { apiKeyEnvName, resolveEffectiveModel } from '@yo-harness/core/config/resolve-model.js';
import type { ModelConfigStore } from '@yo-harness/core/core/ports.js';
import { LLMGateway } from '@yo-harness/core/llm/gateway.js';
import { createModelCatalog } from '@yo-harness/core/llm/model-catalog.js';
import { AnthropicLLMClient } from '@yo-harness/core/llm/providers/anthropic.js';
import { FakeLLMClient } from '@yo-harness/core/llm/providers/fake.js';
import { OpenAICompatLLMClient } from '@yo-harness/core/llm/providers/openai-compat.js';
import { ModelRouter } from '@yo-harness/core/router/model-router.js';
import type { Logger } from '@yo-harness/core/types/common.js';
import { ValidationError } from '@yo-harness/core/types/errors.js';
import type { LLMClient } from '@yo-harness/core/types/llm.js';
import type {
  ConfigSource,
  EffectiveModelConfig,
  ModelDescriptor,
  ModelSelection,
  ProviderKind,
  ProviderProfile,
  ProviderRecord,
} from '@yo-harness/core/types/model-config.js';

import type { SecretCrypto } from './secret-crypto.js';
import { createSecretCrypto, maskSecret } from './secret-crypto.js';

/** 生效运行时：SessionManager / TaskRunner 需要的全部模型相关信息 */
export interface ModelRuntime {
  router: ModelRouter;
  providerId: string;
  kind: ProviderKind;
  model: string;
  contextWindow: number;
  source: ConfigSource;
  /** true = 无可用密钥，已回落到离线 Fake（与既有 server 行为一致） */
  isFake: boolean;
  warnings: string[];
}

/** GET /models 的响应视图 */
export interface ModelConfigView {
  source: ConfigSource;
  active: ModelSelection;
  providers: ProviderProfile[];
  warnings: string[];
}

export interface SaveProviderInput {
  id: string;
  kind: ProviderKind;
  displayName?: string | undefined;
  baseURL?: string | undefined;
  /** 非空 = 覆盖密钥；空/缺省 = 保留已有密钥 */
  apiKey?: string | undefined;
  /** 引用环境变量名（与库内密文二选一；传 null 表示清除） */
  apiKeyEnv?: string | null | undefined;
  models?: ModelDescriptor[] | undefined;
  defaultContextWindow?: number | undefined;
  sortOrder?: number | undefined;
}

export interface DiscoverInput {
  /** 已保存的 provider：用库存密钥与地址 */
  providerId?: string | undefined;
  /** 未保存时的临时参数（保存前测试） */
  kind?: ProviderKind | undefined;
  baseURL?: string | undefined;
  apiKey?: string | undefined;
}

export interface ModelConfigServiceDeps {
  store: ModelConfigStore;
  env?: Record<string, string | undefined> | undefined;
  crypto?: SecretCrypto | undefined;
  logger?: Logger | undefined;
  fetchImpl?: typeof fetch | undefined;
  onChange?: ((runtime: ModelRuntime) => void | Promise<void>) | undefined;
}

function firstNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export class ModelConfigService {
  private readonly store: ModelConfigStore;
  private readonly env: Record<string, string | undefined>;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly onChange: ((runtime: ModelRuntime) => void | Promise<void>) | undefined;
  private readonly injectedCrypto: SecretCrypto | undefined;
  private cryptoInstance: SecretCrypto | undefined;
  private runtime: ModelRuntime | undefined;

  constructor(deps: ModelConfigServiceDeps) {
    this.store = deps.store;
    this.env = deps.env ?? process.env;
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl;
    this.onChange = deps.onChange;
    this.injectedCrypto = deps.crypto;
  }

  /** 主密钥延迟解析：只有真正读写凭据时才需要（避免无谓生成密钥文件） */
  private get crypto(): SecretCrypto {
    this.cryptoInstance ??= this.injectedCrypto ?? createSecretCrypto({ env: this.env });
    return this.cryptoInstance;
  }

  // ─── 解析 ───

  /** 取某个 provider 的凭据：库内密文 → 显式 apiKeyEnv → 约定环境变量名 */
  private resolveKeyFor(records: ProviderRecord[], providerId: string): string | undefined {
    const record = records.find((candidate) => candidate.id === providerId);
    if (record !== undefined) {
      if (record.apiKeyCipher !== undefined) {
        const decrypted = this.crypto.decrypt(record.apiKeyCipher);
        const value = firstNonEmpty(decrypted);
        if (value !== undefined) return value;
      }
      const fromEnv = firstNonEmpty(record.apiKeyEnv !== undefined ? this.env[record.apiKeyEnv] : undefined);
      if (fromEnv !== undefined) return fromEnv;
    }
    return firstNonEmpty(this.env[apiKeyEnvName(providerId)]);
  }

  private toProfile(records: ProviderRecord[], record: ProviderRecord): ProviderProfile {
    const key = this.resolveKeyFor(records, record.id);
    return {
      id: record.id,
      displayName: record.displayName,
      kind: record.kind,
      baseURL: record.baseURL,
      hasKey: key !== undefined,
      apiKeyHint: record.apiKeyHint ?? (key !== undefined ? maskSecret(key) : undefined),
      models: record.models,
      sortOrder: record.sortOrder,
    };
  }

  async listProfiles(): Promise<ProviderProfile[]> {
    const records = await this.store.listProviders();
    return records.map((record) => this.toProfile(records, record));
  }

  async resolve(): Promise<EffectiveModelConfig> {
    const records = await this.store.listProviders();
    const selection = await this.store.getSettings();
    return resolveEffectiveModel({
      persisted: { selection, profiles: records.map((record) => this.toProfile(records, record)) },
      resolveStoredKey: (providerId) => this.resolveKeyFor(records, providerId),
      env: this.env,
    });
  }

  async view(): Promise<ModelConfigView> {
    const records = await this.store.listProviders();
    const selection = await this.store.getSettings();
    const effective = await this.resolve();
    const active: ModelSelection =
      effective.source === 'web' && selection !== undefined
        ? selection
        : { providerId: effective.providerId, model: effective.model };

    return {
      source: effective.source,
      active,
      providers: records.map((record) => this.toProfile(records, record)),
      warnings: effective.warnings,
    };
  }

  // ─── 运行时装配 ───

  private buildClient(effective: EffectiveModelConfig): LLMClient {
    if (effective.apiKey === undefined) {
      // 与既有 server 行为一致：无密钥不阻塞启动，回落离线 Fake
      return new FakeLLMClient([
        { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
      ]);
    }
    if (effective.kind === 'anthropic') {
      return AnthropicLLMClient.create({
        model: effective.model,
        apiKey: effective.apiKey,
        ...(effective.baseURL !== undefined ? { baseURL: effective.baseURL } : {}),
      });
    }
    return OpenAICompatLLMClient.create({
      name: effective.providerId,
      model: effective.model,
      apiKey: effective.apiKey,
      ...(effective.baseURL !== undefined ? { baseURL: effective.baseURL } : {}),
    });
  }

  async buildRuntime(): Promise<ModelRuntime> {
    const effective = await this.resolve();
    const client = this.buildClient(effective);
    const gateway = new LLMGateway(new Map([[effective.providerId, client]]), {
      defaultProvider: effective.providerId,
    });

    return {
      router: new ModelRouter(gateway, {}),
      providerId: effective.providerId,
      kind: effective.kind,
      model: effective.model,
      contextWindow: effective.contextWindow,
      source: effective.source,
      isFake: effective.apiKey === undefined,
      warnings: effective.warnings,
    };
  }

  /** 懒加载（首次调用时构建） */
  async getRuntime(): Promise<ModelRuntime> {
    this.runtime ??= await this.buildRuntime();
    return this.runtime;
  }

  /** 配置变更后重建，并把新运行时通知装配层 */
  async refresh(): Promise<ModelRuntime> {
    const next = await this.buildRuntime();
    this.runtime = next;
    await this.onChange?.(next);
    return next;
  }

  // ─── 写操作 ───

  async saveProvider(input: SaveProviderInput): Promise<ProviderProfile> {
    const id = input.id.trim();
    if (id.length === 0) throw new ValidationError('provider id 不能为空');

    const existing = await this.store.getProvider(id);
    const baseURL = input.baseURL !== undefined ? firstNonEmpty(input.baseURL) : existing?.baseURL;
    const kind = input.kind;

    if (kind === 'openai-compat' && baseURL === undefined) {
      throw new ValidationError(`provider "${id}" 使用 OpenAI 兼容协议时必须填写 API 地址`);
    }

    const newKey = firstNonEmpty(input.apiKey);
    const record = await this.store.upsertProvider({
      id,
      displayName: firstNonEmpty(input.displayName) ?? existing?.displayName ?? id,
      kind,
      baseURL,
      apiKeyCipher: newKey !== undefined ? this.crypto.encrypt(newKey) : existing?.apiKeyCipher,
      apiKeyHint: newKey !== undefined ? maskSecret(newKey) : existing?.apiKeyHint,
      apiKeyEnv:
        input.apiKeyEnv !== undefined
          ? (firstNonEmpty(input.apiKeyEnv ?? undefined) ?? undefined)
          : existing?.apiKeyEnv,
      models: input.models ?? existing?.models ?? [],
      defaultContextWindow: input.defaultContextWindow ?? existing?.defaultContextWindow,
      sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
    });

    const hasKey = newKey !== undefined || record.apiKeyCipher !== undefined || firstNonEmpty(record.apiKeyEnv !== undefined ? this.env[record.apiKeyEnv] : undefined) !== undefined;
    this.logger?.info('model provider saved', { id, kind, hasKey });

    const records = await this.store.listProviders();
    const profile = this.toProfile(records, record);
    await this.refresh();
    return profile;
  }

  async deleteProvider(id: string): Promise<void> {
    await this.store.deleteProvider(id);
    const active = await this.store.getSettings();
    if (active?.providerId === id) {
      await this.store.clearSettings();
      this.logger?.info('active model selection cleared because its provider was removed', { id });
    }
    await this.refresh();
  }

  async saveSelection(selection: ModelSelection): Promise<void> {
    const model = selection.model.trim();
    if (model.length === 0) throw new ValidationError('model 不能为空');

    const provider = await this.store.getProvider(selection.providerId);
    if (provider === undefined) throw new ValidationError(`provider "${selection.providerId}" 不存在`);

    await this.store.saveSettings({ providerId: selection.providerId, model });
    this.logger?.info('active model selection saved', { providerId: selection.providerId, model });
    await this.refresh();
  }

  /** 获取可用模型：providerId 优先，否则用调用方传入的临时凭据（保存前试连） */
  async discover(input: DiscoverInput): Promise<ModelDescriptor[]> {
    let kind = input.kind;
    let baseURL = input.baseURL;
    let apiKey = firstNonEmpty(input.apiKey);

    if (input.providerId !== undefined) {
      const record = await this.store.getProvider(input.providerId);
      if (record === undefined) {
        throw new ValidationError(`provider "${input.providerId}" 不存在`);
      }
      kind = record.kind;
      baseURL = input.baseURL ?? record.baseURL;
      if (apiKey === undefined) {
        const records = await this.store.listProviders();
        apiKey = this.resolveKeyFor(records, input.providerId);
      }
    }

    if (kind === undefined) throw new ValidationError('缺少 API 协议（kind）');

    const catalog = createModelCatalog({
      kind,
      baseURL,
      apiKey,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    });
    return catalog.listModels();
  }
}
