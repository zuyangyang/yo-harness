# yo-harness 模型配置（Web UI）设计文档

> 版本 v1.0 · 状态：待评审
> 范围：Web UI 中配置 Provider / 模型、持久化保存、通过 API 自动获取可用模型、与现有 `.env` 的优先级兼容
> 覆盖层次：core（配置解析 + 模型目录端口）、server（存储 + REST API + 运行时重建）、web（设置页 UI + 状态）
> 关联文档：docs/SESSION-WORKSPACE-DESIGN.md（会话存储与迁移范式）、docs/UI-REDESIGN.md（前端 IA/组件规范）
> **本期非目标**：不同角色（main / planner / compressor / extractor）分派不同模型。`modelRoles` 的有效化放到后续迭代，本期只解决「当前用哪个 provider + 哪个模型」。

## 目录

1. 背景与目标
2. 现状盘点（代码事实）
3. 术语与领域模型
4. 配置解析与优先级（兼容 `.env` 的核心）
5. 数据模型与迁移（v5 → v6）
6. 密钥存储与安全
7. 核心域：模型目录端口（core）
8. 服务端：ModelConfigService
9. 服务端：REST API
10. 运行时生效与传播
11. 前端设计
12. 兼容性、回退与边界
13. 实施路线图
14. 测试策略
15. 风险与开放问题
附录 A：接口请求/响应示例
附录 B：涉及文件清单

---

## 1. 背景与目标

### 1.1 背景

当前 yo-harness 的「用哪个模型」完全由启动时的环境与命令行决定，且服务端与 Web UI 之间没有配置通道：

- 配置优先级写死在 `packages/core/src/config/config.ts`：CLI flag > 环境变量（`.env`）> `~/.yo-harness/config.json` > 内置默认；
- `packages/server/src/index.ts` 的 `main()` 只从 `YO_PROVIDER` / `YO_MODEL` / `YO_BASE_URL` 组装**唯一一个** provider 与 client，进程启动后不可变；
- `packages/web/src/features/settings/SettingsView.tsx` 的「模型」分区目前是 `ComingSoon` 占位，没有任何配置能力；
- `GET /api/v1/models`（`packages/server/src/routes/models.ts`）只是把 `serverConfig.providers` / `modelRoles` 静态回显，**不查询 provider 真实可用模型**；
- 没有任何存放模型配置的持久化表（`packages/core/src/storage/db.ts` 的 SCHEMA_VERSION 为 5，表为 meta / sessions / events / checkpoints / memories / tasks / users / api_keys / workspaces）。

结果是：换模型必须改 `.env` 并重启 server，自定义 provider（如 `wlyd` 这类 OpenAI 兼容网关）只能靠预先存在的 `OPENAI_COMPAT_API_KEY` 变量名，无法在 UI 里管理多个 Provider。

### 1.2 目标

1. **Web UI 配置**：在「设置 → 模型」中可以新增 / 编辑 / 删除 Provider，填写显示名称、API 地址、API 协议、API 密钥，并管理该 Provider 的模型目录；保存后持久化。
2. **选择当前模型**：可以选择当前生效的 Provider + 模型，作为新建会话的默认模型。
3. **自动获取可用模型**：在 UI 点击「获取可用模型」时，由 server 调用 Provider 的模型列表接口，返回真实可用的模型 ID 列表。
4. **兼容 `.env`**：未在 Web UI 配置时，服务端行为与今天完全一致（继续读 `.env` / 进程环境）；一旦 Web UI 有可用配置，则 **Web UI 优先**。
5. **可追溯**：UI 必须显示当前生效配置的**来源**（Web UI / .env / 内置默认），避免"我改的没生效"这类困惑。

### 1.3 非目标（本期不做）

- 不同角色分派不同模型（`modelRoles` 真正落地）；本期 `ModelRouter` 的角色表保持为空。
- 每个会话独立的模型覆盖（本期为全局默认；会话级 `model` 字段仍按现状记录）。
- 多模态 / 嵌入 / 语音等非 Chat 模型的路由。
- Provider 凭据的 OAuth / 企业 SSO。
- CLI 本地模式读取 Web UI 配置（见 §12.3，列为 v2）。

---

## 2. 现状盘点（代码事实）

### 2.1 配置与装配

| 位置 | 现状 | 缺口 |
| --- | --- | --- |
| `packages/core/src/config/config.ts` | `loadConfig()` 实现 flag > env > file > default；provider 仅枚举 `anthropic` / `openai-compat` | 无"Web UI"来源；`providers` 是固定两项，无法承载自定义 Provider |
| `packages/server/src/config.ts` | `ServerConfig.providers: ModelProviderConfig[]`（数组）、`modelRoles` | 数组形态已具备扩展性，但消费方只用第 0 项 |
| `packages/server/src/index.ts:66-72` | `providerName = providers[0]`；`buildServerLlmClient()` 用 `API_KEY_ENV` 映射取 key；网关只注册 1 个 client | 启动后不可变；key 只能来自环境变量；自定义 provider 无法注册 |
| `packages/server/src/session-manager.ts:61,67,210,179` | 构造期注入**静态** `router` 与 `contextWindow` | 运行期换模型后，已创建的 loop 仍指向旧 router |

### 2.2 存储

| 位置 | 现状 |
| --- | --- |
| `packages/core/src/storage/db.ts` | SQLite schema，`SCHEMA_VERSION = '5'`，逐版本迁移（v1→v5），事务包裹 |
| `packages/server/src/storage/schema.ts` / `migrate.ts` | PostgreSQL 侧 schema 与迁移 |
| `packages/server/src/storage/interface.ts` | `StorageBackend` = sessions / workspaces / events / checkpoints / memories / tasks / users / apiKeys + initialize/close |

> 结论：新增模型配置需要一个新 store，并同时在 SQLite 与 PostgreSQL 两侧落表 + 升版本。

### 2.3 前端与 API

| 位置 | 现状 | 缺口 |
| --- | --- | --- |
| `packages/web/src/features/settings/SettingsView.tsx:17` | `models` 分区为占位 | 无 UI |
| `packages/web/src/components/Model/ModelSelector.tsx` | 调用 `api.models.list()` 渲染下拉 | 数据源是静态 config，非真实可用模型 |
| `packages/web/src/api/client.ts:251` | `api.models.list()` 只有 GET | 无写接口、无 discovery |
| `packages/server/src/routes/models.ts` | 只有 `GET /` | 无 PUT/POST/DELETE |

---

## 3. 术语与领域模型

| 术语 | 含义 |
| --- | --- |
| **Provider（提供商）** | 一个 LLM 服务端点：显示名、协议、API 地址、凭据。例如「DeepSeek」「wlyd」。 |
| **ProviderKind（协议）** | 调用协议：`openai-compat`（OpenAI Chat Completions 兼容）或 `anthropic`。 |
| **ModelCatalog（模型目录）** | 某 Provider 下的可用模型 ID 列表，来源为 discovery 结果或手工录入。 |
| **ModelSelection（当前选择）** | 全局默认的 `{ providerId, model }`，新建会话使用。 |
| **EffectiveModelConfig（生效配置）** | 解析优先级后的最终结果：是否来自 Web UI、baseURL、apiKey、contextWindow、provider 标识。 |
| **ConfigSource（来源）** | `'web' | 'env' | 'file' | 'default'`，用于 UI 展示与排障。 |

领域对象（core 共享类型）：

```ts
// packages/core/src/types/model-config.ts

export type ProviderKind = 'openai-compat' | 'anthropic';

/** 持久化的 Provider 档案（不含明文密钥） */
export interface ProviderProfile {
  id: string;                 // 稳定标识，如 'deepseek' / 'wlyd' / uuid
  displayName: string;        // 「显示名称」
  kind: ProviderKind;         // 「API 协议」
  baseURL: string | undefined;// 「API 地址」（anthropic 可缺省官方端点）
  apiKeyHint: string | undefined; // 形如 'sk-…c0eA'，仅用于展示「已配置」
  hasKey: boolean;            // 是否已存有凭据（含来自 env 的）
  models: ModelDescriptor[];  // 「模型目录」
  sortOrder: number;
}

export interface ModelDescriptor {
  id: string;                 // 传入模型的字符串
  contextWindow?: number;     // 可选，未知则用 provider 级默认
}

export interface ModelSelection {
  providerId: string;
  model: string;
}

/** 解析结果：生效配置 + 来源 + 可展示的告警 */
export interface EffectiveModelConfig {
  source: ConfigSource;
  providerId: string;
  kind: ProviderKind;
  baseURL: string | undefined;
  model: string;
  contextWindow: number;
  /** 运行时才注入，绝不进入任何持久化 / 事件 / 日志 */
  apiKey: string | undefined;
  warnings: string[];
}
```

---

## 4. 配置解析与优先级（兼容 `.env` 的核心）

### 4.1 优先级

```
最终生效模型配置 =
  1) Web UI 持久化配置（server DB：model_settings + model_providers）  ← 最高
  2) 进程环境 / .env（YO_PROVIDER / YO_MODEL / YO_BASE_URL / *_API_KEY）
  3) ~/.yo-harness/config.json（仅 CLI 本地模式）
  4) 内置默认（PROVIDER_DEFAULTS）
```

### 4.2 解析规则

1. 若 `model_settings` 存在 `active.providerId + active.model`，且对应 Provider 能解析出凭据（DB 内密文可解密，**或** 其 `apiKeyEnv` 在环境中存在）→ 采用，`source = 'web'`。
2. 否则退回 §4.1 第 2 项，即**当前 server 的既有逻辑**，`source = 'env'`。
3. Web UI 配置存在但不可用（Provider 被删、密钥缺失、baseURL 非法）时：**降级到 env**，并在结果中写入 `warnings`，UI 用黄色提示条展示，例如：
   > 「Web UI 中的 provider『wlyd』缺少 API 密钥，当前回退到 .env 的 openai-compat。」（来源：.env）
4. 纯函数实现，便于单测，且 CLI 后续可复用：

```ts
// packages/core/src/config/resolve-model.ts
export function resolveEffectiveModel(input: {
  persisted: { selection: ModelSelection | undefined; profiles: ProviderProfile[] } | undefined;
  resolveStoredKey: (providerId: string) => string | undefined;
  env: Record<string, string | undefined>;
  file: ConfigFile | undefined;
}): EffectiveModelConfig;
```

### 4.3 环境变量映射（保持向后兼容）

| `.env` 变量 | 语义 | 解析为 |
| --- | --- | --- |
| `YO_PROVIDER` | `anthropic` 或 `openai-compat` | providerId = 同名；kind 同名 |
| `YO_MODEL` | 生效模型 | `selection.model` |
| `YO_BASE_URL` | 仅 openai-compat 生效 | baseURL |
| `ANTHROPIC_API_KEY` / `OPENAI_COMPAT_API_KEY` | 凭据 | apiKey |

> 本期不删除、不改语义。**未在 Web UI 保存任何内容时，server 行为与今天逐字节一致。**

---

## 5. 数据模型与迁移（v5 → v6）

### 5.1 新增表

**`model_providers`**（每租户多条）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | Provider 标识 |
| `display_name` | TEXT NOT NULL | 「显示名称」 |
| `kind` | TEXT NOT NULL | `openai-compat` / `anthropic` |
| `base_url` | TEXT NULL | 「API 地址」 |
| `api_key_cipher` | TEXT NULL | AES-256-GCM 密文（见 §6） |
| `api_key_hint` | TEXT NULL | 掩码提示，如 `sk-…c0eA` |
| `api_key_env` | TEXT NULL | 可选：不回填密钥，改为引用环境变量名 |
| `models_json` | TEXT NOT NULL DEFAULT '[]' | 「模型目录」JSON 数组 |
| `default_context_window` | INTEGER NULL | 未标注模型时的兜底窗口 |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | 列表排序 |
| `created_at` / `updated_at` | TEXT NOT NULL | 时间戳 |

**`model_settings`**（每租户一行）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 固定 `'default'`（单租户）；多租户沿用 schema-per-tenant 各一行 |
| `active_provider_id` | TEXT NULL | 当前 Provider |
| `active_model` | TEXT NULL | 当前模型 |
| `updated_at` | TEXT NOT NULL | |

### 5.2 迁移

- **SQLite**（`packages/core/src/storage/db.ts`）：新增 `migrateV5ToV6()`，`SCHEMA_VERSION = '6'`。与既有迁移一致，`db.transaction()` 包裹，最后 `UPDATE meta SET value='6'`。
- **PostgreSQL**（`packages/server/src/storage/schema.ts` + `migrate.ts`）：加入等价的 `model_providers` / `model_settings` DDL 与版本推进。
- 迁移必须幂等（`CREATE TABLE IF NOT EXISTS`），且**不清空**任何既有数据。
- 升级后若 `model_settings` 为空 → 全部走 env 回退，零行为变化。

### 5.3 端口与实现

```ts
// packages/core/src/core/ports.ts 追加
export interface ModelConfigStore {
  listProviders(): Promise<ProviderRecord[]>;
  getProvider(id: string): Promise<ProviderRecord | undefined>;
  upsertProvider(record: ProviderRecord): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  getSettings(): Promise<ModelSelection | undefined>;
  saveSettings(selection: ModelSelection): Promise<void>;
}
```

- 实现：`packages/server/src/storage/sqlite-model-config-store.ts` 与 `postgres.ts` 内对应类；
- `StorageBackend` 接口新增 `modelConfig: ModelConfigStore`；
- `ProviderRecord` 是 `ProviderProfile` + 密文/环境变量字段的内部形态，**不对外暴露密文**。

---

## 6. 密钥存储与安全

### 6.1 与既有「密钥纪律」的冲突（需评审确认）

现有不变量（README + `config.ts` 注释）是：**API key 只从环境读取，不进配置对象、不落库、不进事件流**。本功能要求 UI 直接填写密钥并持久化，必然打破该不变量。

**推荐方案（本期采用）**：密钥落库，但**加密存储 + 永不回传**。

| 约束 | 做法 |
| --- | --- |
| 加密算法 | AES-256-GCM，随机 12B IV，密文格式 `v1:<iv>:<tag>:<ciphertext>`（base64） |
| 主密钥来源 | 优先 `YO_SECRET_KEY`（32B base64/hex）；未设置则在 `~/.yo-harness/secret.key` 自动生成，权限 `0600` |
| 回传 | `GET` 只给 `hasKey` + `apiKeyHint`，**任何响应体不含明文或密文** |
| 日志/事件 | 严禁写入 logger、event store、WebSocket 广播 |
| 替换语义 | UI 输入框 placeholder「已配置——输入新值可替换」；空提交 = 不改动已有密钥 |
| 丢失主密钥 | 明确提示：需重新录入密钥（记为已知限制） |

**备选方案**（若评审坚持不落库）：UI 只填写 `apiKeyEnv`（环境变量名），密钥仍由运维放 `.env`。此时 §5.1 的 `api_key_cipher` 弃用，只用 `api_key_env`。此方案更保守但体验与截图不符。

### 6.2 其他安全点

- discovery 请求由 **server 发起**（避免浏览器 CORS 与密钥外泄），带超时（默认 10s）。
- baseURL 校验：仅允许 `http/https`，拒绝 `file:` 等；对内网地址做可选 SSRF 拦截（复用 `packages/core/src/tools/web.ts` 的既有策略或简化版）。
- 权限：写接口默认仅 `admin` 角色（多租户模式）；单租户模式沿用既有鉴权。

---

## 7. 核心域：模型目录端口（core）

现状 `OpenAICompatTransport` 只暴露 `create` / `createStream`，没有 models 列表能力。新增独立端口，**不污染 `LLMClient` 契约**：

```ts
// packages/core/src/llm/model-catalog.ts
export interface ModelCatalogPort {
  listModels(): Promise<ModelDescriptor[]>;
}

export function createOpenAICompatCatalog(opts: {
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;   // 测试注入
}): ModelCatalogPort;

export function createAnthropicCatalog(opts: {
  apiKey: string;
  baseURL?: string;
  fetchImpl?: typeof fetch;
}): ModelCatalogPort;
```

协议细节：

| kind | 请求 | 解析 |
| --- | --- | --- |
| `openai-compat` | `GET {baseURL}/models`，`Authorization: Bearer <key>` | `{ data: [{ id }] }` → `data.map(x => ({ id: x.id }))` |
| `anthropic` | `GET {baseURL ?? 'https://api.anthropic.com'}/v1/models`，头 `x-api-key`、`anthropic-version: 2023-06-01` | `{ data: [{ id, display_name }] }` |

错误处理：非 2xx → `FatalError`/业务错误码；网络失败 → 明确文案；两者都由 route 转为 4xx/5xx + 可读 message。

---

## 8. 服务端：ModelConfigService

### 8.1 职责

新增 `packages/server/src/model-config-service.ts`：

```ts
export class ModelConfigService {
  constructor(private deps: {
    store: ModelConfigStore;
    env: Record<string, string | undefined>;
    crypto: SecretCrypto;             // §6
    logger: Logger;
    onChange?: () => void;            // 通知 SessionManager 失效
  }) {}

  /** 解析生效配置（§4），运行期可随时调用 */
  async resolve(): Promise<EffectiveModelConfig>;

  /** 组装 gateway + router + 上下文窗口，供 SessionManager 使用 */
  async buildRuntime(): Promise<{
    router: ModelRouter;
    providerId: string;
    model: string;
    contextWindow: number;
    source: ConfigSource;
  }>;

  /** 保存 Provider 档案（密钥空 = 不改动） */
  async saveProvider(input: SaveProviderInput): Promise<ProviderProfile>;
  async deleteProvider(id: string): Promise<void>;
  async saveSelection(selection: ModelSelection): Promise<void>;

  /** 发现可用模型（providerId 存在则用库存密钥；否则用临时 apiKey） */
  async discover(input: DiscoverInput): Promise<ModelDescriptor[]>;
}
```

### 8.2 装配改动（`packages/server/src/index.ts`）

现状：

```ts
const providerName = serverConfig.providers[0]?.provider ?? 'fake';
const client = buildServerLlmClient(providerName, providerConf);
const gateway = new LLMGateway(new Map([[providerName, client]]), { defaultProvider: providerName });
const router = new ModelRouter(gateway, serverConfig.modelRoles);
```

改为：

```ts
const modelConfig = new ModelConfigService({ store: storage.modelConfig, env: process.env, crypto, logger });
const runtime = await modelConfig.buildRuntime();   // 内部完成 §4 解析 + 建 client

const sessionManager = new SessionManager({
  // ...
  getRouter: () => runtimeRef.current.router,          // 见 §10
  getContextWindow: () => runtimeRef.current.contextWindow,
  getModelLabel: () => runtimeRef.current.model,
  onModelConfigChanged: () => runtimeRef.current.refresh(),
});
```

> `buildServerLlmClient` 扩展为接受任意 `ProviderProfile`（不再依赖固定的 `API_KEY_ENV` 映射；env 回退路径沿用旧映射以保证兼容）。无配置时仍返回 FakeLLMClient，行为不变。

---

## 9. 服务端：REST API

全部挂载在既有 `/api/v1/models`（`packages/server/src/routes/models.ts`），受 `authMiddleware` 保护。

### 9.1 `GET /api/v1/models`（扩展，兼容旧字段）

返回 provider 列表 + 当前选择 + 生效来源。**保留 `models` / `roles` 旧字段**避免破坏 `ModelSelector`。

```jsonc
{
  "source": "web",                       // web | env | file | default
  "active": { "providerId": "wlyd", "model": "deepseek-v4-pro" },
  "providers": [
    {
      "id": "deepseek",
      "displayName": "DeepSeek",
      "kind": "openai-compat",
      "baseURL": "https://api.deepseek.com/v1",
      "hasKey": true,
      "apiKeyHint": "sk-…c0eA",
      "models": [{ "id": "deepseek-chat" }]
    }
  ],
  "warnings": [],
  "models": [{ "provider": "wlyd", "model": "deepseek-v4-pro", "contextWindow": 128000 }], // 旧字段
  "roles": []
}
```

### 9.2 其余接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `PUT` | `/api/v1/models/providers/:id` | 新增或更新 Provider（`apiKey` 为空表示不改） |
| `DELETE` | `/api/v1/models/providers/:id` | 删除 Provider（若为 active，同时清空 selection 并回退 env） |
| `PUT` | `/api/v1/models/active` | 保存当前选择 `{ providerId, model }` |
| `POST` | `/api/v1/models/discover` | 获取可用模型，body `{ providerId?, kind, baseURL, apiKey? }` |
| `POST` | `/api/v1/models/test` | （可选）连通性测试，返回延迟与错误 |

统一错误体：`{ error: { code, message } }`，HTTP 400/401/403/404/502 语义化。

---

## 10. 运行时生效与传播

### 10.1 关键改造点

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `SessionManagerDeps.router` | 静态字段 | `getRouter(): ModelRouter` 访问器 |
| `SessionManagerDeps.contextWindow` | 静态数字 | `getContextWindow(): number` 访问器 |
| `session-manager.ts` `getOrCreate()` | 直接用 `deps.router` / `deps.contextWindow` | 每次创建 loop 时调用访问器，拿到**当前**配置 |
| `SessionManager` | 无失效机制 | 新增 `onModelConfigChanged()`：驱逐**空闲**活跃会话（`running === false`），下次消息重新建 loop |

### 10.2 生效语义（明确定义）

1. 保存配置后，server **立即**重建 gateway/router/contextWindow。
2. **正在执行的 turn 不中断**，继续用旧 client 跑完（避免半途换模型导致消息错乱）。
3. turn 结束后，该会话若已被驱逐，下一条消息用新配置重建。
4. **新建会话**一律用新配置。
5. 通过既有 WebSocket 广播一条控制事件（`model_config_changed`），前端刷新「当前模型」显示。

### 10.3 上下文窗口

`ContextManager` 依赖 `contextWindow` 做裁剪。既然模型可换，窗口必须来自生效配置：

- 优先 `ModelDescriptor.contextWindow`（若 discovery/手工标注提供）；
- 否则 `provider.default_context_window`；
- 否则内置默认（`openai-compat` 128k / `anthropic` 200k，与 `PROVIDER_DEFAULTS` 一致）。

---

## 11. 前端设计

### 11.1 结构（对齐截图）

将 `SettingsView` 的 `models` 分区从 `ComingSoon` 替换为 `ModelsSection`：

```
设置 / 模型
├─ 说明文案：「填入各提供商的 API 密钥即可使用其模型。」+ 「打开配置文件」入口
├─ 当前使用（ActiveModelCard）
│   ├─ 生效来源徽标：Web UI / .env / 默认
│   ├─ Provider 下拉 + 模型下拉
│   └─ 保存按钮 + 成功/失败 Toast
├─ Provider 列表（ProviderCard[]）
│   ├─ 卡片头：显示名 + 状态点（已配置密钥=绿）+ [编辑] [删除]
│   └─ 展开编辑区（ProviderEditor）
│       ├─ API 密钥（password，placeholder「已配置——输入新值可替换」）
│       └─ 自定义设置（可折叠）
│           ├─ 显示名称
│           ├─ API 地址
│           └─ API 协议（OpenAI Chat Completions / Anthropic）下拉
│       └─ 模型目录
│           ├─ [获取可用模型] [恢复默认模型]
│           └─ 模型行：显示名 ← 模型 ID，[删除]
└─ 新增 Provider 按钮
```

### 11.2 组件与文件

| 文件 | 作用 |
| --- | --- |
| `packages/web/src/features/settings/ModelsSection.tsx` | 分区容器，加载/保存/错误态 |
| `packages/web/src/features/settings/model/ActiveModelCard.tsx` | 当前选择 |
| `packages/web/src/features/settings/model/ProviderCard.tsx` | 卡片头 + 展开 |
| `packages/web/src/features/settings/model/ProviderEditor.tsx` | 密钥 / 自定义设置表单 |
| `packages/web/src/features/settings/model/ModelCatalogEditor.tsx` | 模型目录 + 获取可用模型 |
| `packages/web/src/stores/model.ts` | zustand：providers / active / source / loading / error |
| `packages/web/src/api/client.ts` | 追加 `api.models.providers.*` / `active` / `discover` |

### 11.3 状态与交互

- 初始加载 `GET /api/v1/models`；写操作后以响应体回填（避免二次请求）。
- 「获取可用模型」：按钮 → loading → `POST /discover` → 结果与本地目录合并（去重）→ 需点「保存」才持久化。
- 「恢复默认模型」：填充该 kind 的内置默认列表（如 deepseek 系列），不直接覆盖已保存数据，直到保存。
- 密钥输入框：从不回填真实值；`hasKey` 为真时 placeholder 显示「已配置」。
- 所有敏感字段 `type="password"`、`autoComplete="off"`。
- 未登录/无权限：沿用既有 Auth 守卫；403 时展示只读视图。

---

## 12. 兼容性、回退与边界

### 12.1 对既有行为的保证

| 场景 | 期望 |
| --- | --- |
| 从未使用 Web UI 配置 | 与今天完全一致（env 生效，`source='env'`） |
| DB 有配置但密钥缺失 | 回退 env + `warnings`，不崩溃 |
| DB 有配置且可用 | Web UI 优先 |
| `--fake` / 无 key | 仍可走 FakeLLMClient（保持既有"无 key 不崩"策略） |
| 旧版 `ModelSelector` | `GET /models` 保留 `models` 字段，不破坏 |

### 12.2 删除语义

- 删除 active provider：清空 `model_settings`，立即回退 env，并广播变更。
- 删除非 active provider：仅删卡片。

### 12.3 CLI 边界（v1 明确不做）

- CLI 本地模式仍读 `.env` + `~/.yo-harness/config.json`，**不读 server DB**。
- v2 备选：`yo --server` 模式下从 server 拉取模型列表；或提供「导出到 config.json」按钮。需评估双源一致性成本，本期只在文档记录。

---

## 13. 实施路线图

> 建议按层落地，每阶段可独立测试与合入。

### 阶段 1：core 类型与解析（无行为变更）
1. 新增 `packages/core/src/types/model-config.ts`（§3 类型）。
2. 新增 `packages/core/src/config/resolve-model.ts`（§4 纯函数）+ 单测。
3. 新增 `packages/core/src/llm/model-catalog.ts`（§7 端口）+ 单测（注入 fetch）。

### 阶段 2：存储与迁移
4. `db.ts` 增 `migrateV5ToV6`，`SCHEMA_VERSION='6'`。
5. Postgres `schema.ts` / `migrate.ts` 同步。
6. 新增 `ModelConfigStore` 端口与 SQLite / Postgres 实现；`StorageBackend` 加字段。
7. 新增 `SecretCrypto`（AES-256-GCM）+ 单测（加解密往返、缺主密钥行为）。

### 阶段 3：服务端服务与 API
8. `model-config-service.ts`（§8）+ 单测（优先级 / 回退 / 告警）。
9. 扩展 `buildServerLlmClient` 支持任意 ProviderProfile。
10. `routes/models.ts` 实现 §9 全部接口 + 集成测试。
11. `index.ts` 装配改造。

### 阶段 4：运行期生效
12. `session-manager.ts` 改用访问器；新增 `onModelConfigChanged()`。
13. 保存后重建 + WebSocket 广播 + 空闲会话驱逐。
14. 集成测试：改配置 → 新会话用新模型；在途 turn 不受影响。

### 阶段 5：前端
15. `stores/model.ts` + `api/client.ts` 扩展。
16. `ModelsSection` 及子组件，接入 `SettingsView`。
17. 组件测试 + 视觉核对（对齐截图）。

### 阶段 6：收尾
18. 文案与 `.env.example` / README 更新（说明新增 `YO_SECRET_KEY`）。
19. `npm run check`（typecheck + lint + test）全绿。

---

## 14. 测试策略

| 层 | 用例 |
| --- | --- |
| core 解析 | 四种来源优先级；web 缺 key → 回退；非法 baseURL；warnings 内容 |
| core 目录 | openai-compat 正常/非 2xx/超时；anthropic 头部正确；响应字段缺失容错 |
| 存储 | v5→v6 迁移幂等；SQLite/Postgres 双端 CRUD；settings 单行 upsert |
| 加密 | 加解密往返；篡改密文失败；无 `YO_SECRET_KEY` 时生成 key 文件权限 0600 |
| API | GET 不回传密钥；PUT 空 key 不改动；DELETE active 回退；discover 转发正确；权限 403 |
| 运行期 | 保存后新会话用新模型；在途 turn 用旧 client；WS 广播 |
| 前端 | ModelsSection 加载/保存/错误；密钥 placeholder；discover 合并去重 |
| 回归 | 无 DB 配置时行为与改动前一致（快照 env 路径） |

---

## 15. 风险与开放问题

| # | 风险 / 问题 | 建议 |
| --- | --- | --- |
| 1 | **密钥落库打破既有纪律**，需明确 sign-off | 采用 §6.1 加密方案；若否决则改走 `apiKeyEnv` 只存变量名 |
| 2 | 主密钥丢失 → 凭据不可恢复 | 文档明确；可提供「重新录入」引导 |
| 3 | 运行期换 client 的在途 turn 语义 | 已定义：不打断在途 turn（§10.2） |
| 4 | Anthropic `/v1/models` 可用性与版本头 | discovery 失败时降级为手工录入，不阻塞保存 |
| 5 | 不同模型 contextWindow 未知 → 裁剪不准 | ModelDescriptor 允许标注；否则用 provider 默认 |
| 6 | 多租户下模型配置隔离 | 沿用 schema-per-tenant；写操作限 admin |
| 7 | 与 `modelRoles` 的后续衔接 | 本期 `modelRoles` 置空；下期在 `ModelRouter` 中消费（需为每个角色建 client） |
| 8 | 自定义 Provider 与 `ProviderName` 枚举冲突 | 引入独立 `providerId`，不扩展 core 的 `ProviderName` 枚举，避免影响 CLI |

---

## 附录 A：接口请求/响应示例

**保存 Provider**

```http
PUT /api/v1/models/providers/wlyd
Content-Type: application/json

{
  "displayName": "wlyd",
  "kind": "openai-compat",
  "baseURL": "https://gpt-gateway-uat.wanmol.com/v1",
  "apiKey": "sk-****",                       // 空字符串 / 省略 = 不改动
  "models": [{ "id": "deepseek-flash" }, { "id": "deepseek-v4-1-flash-260910" }],
  "defaultContextWindow": 128000
}
```

响应（密钥不外泄）：

```json
{
  "provider": {
    "id": "wlyd",
    "displayName": "wlyd",
    "kind": "openai-compat",
    "baseURL": "https://gpt-gateway-uat.wanmol.com/v1",
    "hasKey": true,
    "apiKeyHint": "sk-…z63h",
    "models": [{ "id": "deepseek-flash" }]
  }
}
```

**获取可用模型**

```http
POST /api/v1/models/discover
Content-Type: application/json

{ "providerId": "wlyd" }        // 或 { "kind": "openai-compat", "baseURL": "...", "apiKey": "..." } 用于保存前测试
```

```json
{ "models": [{ "id": "deepseek-flash" }, { "id": "deepseek-v4-1-flash-260910" }, { "id": "deepseek-v4-pro" }] }
```

**保存当前选择**

```http
PUT /api/v1/models/active
Content-Type: application/json

{ "providerId": "wlyd", "model": "deepseek-v4-pro" }
```

## 附录 B：涉及文件清单

**新增**

- `packages/core/src/types/model-config.ts`
- `packages/core/src/config/resolve-model.ts`
- `packages/core/src/llm/model-catalog.ts`
- `packages/server/src/model-config-service.ts`
- `packages/server/src/secret-crypto.ts`
- `packages/server/src/storage/sqlite-model-config-store.ts`（或并入 `sqlite.ts`）
- `packages/web/src/features/settings/ModelsSection.tsx`（+ `model/` 子组件）
- `packages/web/src/stores/model.ts`
- 对应 `*.test.ts` / `*.test.tsx`

**修改**

- `packages/core/src/storage/db.ts`（v6 迁移）
- `packages/core/src/core/ports.ts`（`ModelConfigStore`）
- `packages/server/src/storage/interface.ts` / `sqlite.ts` / `postgres.ts` / `schema.ts` / `migrate.ts`
- `packages/server/src/routes/models.ts`（实现全部接口）
- `packages/server/src/app.ts`（注入 service）
- `packages/server/src/index.ts`（装配 + `buildServerLlmClient` 泛化）
- `packages/server/src/session-manager.ts`（访问器 + 失效）
- `packages/web/src/features/settings/SettingsView.tsx`（挂载 `ModelsSection`）
- `packages/web/src/api/client.ts`（新增方法与类型）
- `.env.example` / `README.md`（新增 `YO_SECRET_KEY` 说明）
