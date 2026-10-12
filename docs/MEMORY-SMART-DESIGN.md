# yo-harness 记忆系统智能化设计文档

> 范围：`packages/core`（记忆引擎 + 存储）、`packages/server`（装配 + 生命周期）、`packages/web`（记忆面板）
> 目标：记忆「只存有价值的、能自动更新、会过期」，让检索更准、注入更省 token
> 参考：本文件 §3 与附录 A（Mem0 / Generative Agents / Zep-Graphiti / Letta / A-MEM / LangMem / Cognee）

---

## 1. 需求拆解

| # | 需求 | 现状 | 目标 |
|---|---|---|---|
| 1 | 只存有价值记忆 | 单一 LLM 提取 prompt；对话 >300 字就调一次；无重要性概念 | 双闸门：**重要性/耐久性评分 + 阈值过滤**；低价值直接 NOOP，不落库 |
| 2 | 自动更新而非全量 append | 只 `create`；标题归一化**精确**匹配去重 | **关系决策**（add / update / supersede / merge / noop）+ **稳定 key 的确定性 upsert** |
| 3 | 记忆有时效性 | 无任何时间维度，`active` 即永久 | **`expires_at` 隐藏式过期** + **衰减排序** + **durable / ephemeral 分层** |

一句话设计取向：**用「稳定 key 做确定性 upsert」当骨架，用「LLM 关系决策」做补充，用「supersede 不删除 + 衰减只影响排序」保证可逆。**

---

## 2. 现状与差距（代码事实）

- 表结构（schema v8，[db.ts:175-208](../packages/core/src/storage/db.ts)）：`memories(id,title,content,category,description,keywords,status,source_session_id,created_at,updated_at)` + FTS5 外部内容表 + 3 个同步触发器。`status` 只有 `active|archived`，**无 CHECK 约束** → 扩展枚举不需要改 DDL 约束。
- 写入（[extractor.ts:86-100](../packages/core/src/memory/extractor.ts)）：对每条候选只 `store.create(...)`，去重仅 `normalizeTitle` 精确匹配 → **标题一变就重复**。
- 存储端口（[ports.ts:187-194](../packages/core/src/core/ports.ts)）：`create/get/update/archive/listActive/search`，**没有按 key upsert、没有 touch、没有过期扫描**。
- 读取（[injector.ts:67-105](../packages/core/src/memory/injector.ts)）：`listActive()` 全量取，按 `created_at DESC` 截断 `maxItems=50`；**无时间过滤、无相关性排序**。
- 触发（[session-manager.ts:207](../packages/server/src/session-manager.ts#L207) / [:346](../packages/server/src/session-manager.ts#L346) / [:576](../packages/server/src/session-manager.ts#L576)）：`turn_end`（≥300 字符）、`session_end`（≥100）、手动 force。
- 双后端：SQLite 手写 DDL（`db.ts`）+ Postgres Drizzle（[schema.ts:99-117](../packages/server/src/storage/schema.ts) + `migrate.ts`）→ **任何加列都要两边同步**。
- 无 embedding/向量能力；模型角色只有 `main|planner|compressor|extractor`（[router.ts:9](../packages/core/src/types/router.ts)）。
- 曾经的「update」是模型自己用 `shell` + `sqlite3` 直接写库，绕过了 `MemoryStore` 校验与事件流（见 §10 风险）。

---

## 3. 业内做法与本方案取舍

| 系统 | 价值闸门 | 更新机制 | 时效/遗忘 | 我们采纳 |
|---|---|---|---|---|
| **Mem0（经典）** | 提取 prompt 的 Do-Not 规则 + 关系判定 | 取 top-s=10 相似记忆，LLM 出 **ADD/UPDATE/DELETE/NOOP**，决策存 `event` 字段 | — | ✅ 采纳「两阶段：提取 → 关系决策」与操作枚举 |
| **Mem0（2026 v3）** | 给定画像 + 最近 20 条已提取记忆做去重 | **只 ADD**，冲突交给检索与后台 Dream | Supersede / Merge / 定时 Synthesis | ✅ 采纳 Supersede/Merge 语义（不删、加指针、`latest_only` 读） |
| **Generative Agents** | 写入时 LLM 打 **1–10 重要度** | — | recency `0.995^小时`，最终 `score=α·recency+α·importance+α·relevance`（α 全 1） | ✅ 采纳「一次性重要性评分 + 时间衰减排序」 |
| **Zep / Graphiti** | 事实级抽取 | 矛盾时**只失效不删除**：`invalid_at = 新事实的 valid_at`，四时间戳双时态 | 无 TTL，靠时间轴 | ✅ 采纳双时态（`valid_from/valid_to/superseded_by`） |
| **Letta / MemGPT** | 结构化：常驻 memory block 有硬字符预算 | 上下文压力下驱逐 + 递归摘要 | 无 TTL，归档仍可检索 | ✅ 采纳「durable 常驻层 vs 按需检索层」分层 |
| **A-MEM** | `should_evolve` 演化决策 | `strengthen/update_neighbor`，可改写邻居的 context/tags | 无 TTL | ⚠️ 暂不采纳（需图结构） |
| **LangMem** | 显式 `enable_inserts/enable_deletes` + 自定义 schema | 并行工具调用 add/update/delete | — | ✅ 采纳「用结构化 schema 约束记忆必须自包含」 |
| **Mem0 过期 & 衰减** | — | — | `expiration_date`（UTC，含当日，**只隐藏不删**，空=永久，非法值 fail-open）；衰减是有 **0.3× 下限**的排序偏置，**永不过滤** | ✅ 直接照搬这两条契约 |

关键结论（研究者反复强调的一点）：**业内普遍把「这条值不值得存」和「该怎么处理它」拆成两步**——即使激进到 ADD-only 的 Mem0 v3，写入前也必须先取回相关邻居。我们现在恰好缺的就是「取回邻居 + 关系决策」这一步（第 1 条最高杠杆改动）。

---

## 4. 总体设计

```
turn_end / session_end / manual / memory 工具
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage A  提取（升级现有 extractor）                          │
│  prompt 加：importance(1-10) / durability(durable|ephemeral) │
│             / key(可选稳定槽位) / expiresAt(可选) / confidence │
│  仍输出 memories[]；"无持久事实" 时必须返回空数组             │
└─────────────────────────────────────────────────────────────┘
        │ 候选（含程序化过滤前的原始集）
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage B  价值闸门（程序化，确定性）                          │
│  importance < minImportance        → NOOP                    │
│  durability=ephemeral 且无 expiresAt → 补默认 TTL            │
│  key 已存在                        → 强制 UPDATE（无需 LLM） │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage C  关系决策（reconciler，仅对未命中 key 的候选）       │
│  邻居取回：FTS5 BM25(same category) top-K + 同 key + 标题近似 │
│  一次 LLM 调用 → 每条候选一个操作 + 目标 id：                 │
│     add | update | supersede | merge | noop                  │
│  执行：create / update / supersede(旧 status+valid_to+指针)   │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage D  读取（injector 升级）                               │
│  过滤 status=active 且 (expires_at IS NULL OR > now)         │
│  score = w_r·recencyDecay + w_i·importance + w_v·relevance   │
│  常驻层(pinned/durable) 必注入；其余按 score 取 top-N        │
│  注入后 touch(ids) → 更新 last_accessed_at/access_count      │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
   维护任务（daemon 空闲 / 定时）：expire 扫描、超量淘汰、可选聚类摘要
```

---

## 5. 数据模型（schema v9）

### 5.1 SQLite DDL（新增 `migrateV8ToV9`）

```sql
ALTER TABLE memories ADD COLUMN key             TEXT;                    -- 稳定槽位，如 profile.name / preference.language
ALTER TABLE memories ADD COLUMN importance      INTEGER NOT NULL DEFAULT 5;
ALTER TABLE memories ADD COLUMN durability      TEXT    NOT NULL DEFAULT 'durable'; -- durable | ephemeral
ALTER TABLE memories ADD COLUMN confidence      REAL    NOT NULL DEFAULT 1.0;
ALTER TABLE memories ADD COLUMN pinned          INTEGER NOT NULL DEFAULT 0;         -- 1 = 每 turn 必注入，免疫过期/衰减
ALTER TABLE memories ADD COLUMN expires_at      TEXT;                    -- NULL = 永久
ALTER TABLE memories ADD COLUMN valid_from      TEXT;
ALTER TABLE memories ADD COLUMN valid_to        TEXT;
ALTER TABLE memories ADD COLUMN superseded_by   TEXT;                    -- 指向取代它的记忆 id
ALTER TABLE memories ADD COLUMN last_accessed_at TEXT;
ALTER TABLE memories ADD COLUMN access_count    INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_key        ON memories(key) WHERE key IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_memories_expires    ON memories(expires_at);
CREATE INDEX        IF NOT EXISTS idx_memories_status_upd ON memories(status, updated_at);
```

FTS5 触发器只同步 `title/description/content/keywords`，**加列不影响**（SQLite `ALTER TABLE ADD COLUMN` 不重建触发器）。

### 5.2 Postgres 侧同步

- [schema.ts:99-117](../packages/server/src/storage/schema.ts) 的 `memories` 表加同名 Drizzle 列 + 上述索引；
- `packages/server/src/storage/migrate.ts` 加对应 DDL；
- [postgres.ts:597-695](../packages/server/src/storage/postgres.ts) 的 `PostgresMemoryStore` 实现新端口方法。

### 5.3 类型变更（[types/memory.ts](../packages/core/src/types/memory.ts)）

```ts
export const MemoryStatusSchema = z.enum([
  'active', 'superseded', 'merged', 'expired', 'archived',
]);

export const MemoryDurabilitySchema = z.enum(['durable', 'ephemeral']);

export interface Memory {
  // ...既有字段
  key?: string;
  importance: number;          // 1-10
  durability: 'durable' | 'ephemeral';
  confidence: number;          // 0-1
  pinned: boolean;
  expiresAt?: string;
  validFrom?: string;
  validTo?: string;
  supersededBy?: string;
  lastAccessedAt?: string;
  accessCount: number;
}

export const MemoryExtractionSchema = z.object({
  memories: z.array(z.object({
    title: z.string().min(1).max(100),
    content: z.string().min(1).max(1000),
    category: MemoryCategorySchema,
    description: z.string().min(1).max(200),
    keywords: z.array(z.string().min(1)).min(1).max(10),
    key: z.string().regex(/^[a-z0-9_.]+$/).max(64).optional(),   // 稳定槽位
    importance: z.number().int().min(1).max(10),
    durability: MemoryDurabilitySchema,
    confidence: z.number().min(0).max(1).optional(),
    expiresInDays: z.number().int().min(1).max(3650).optional(), // 只给 ephemeral 用
  })),
});
```

> 让模型输出 `expiresInDays` 而不是绝对日期，避免模型算错日期（比 zep「soft deadline 不等于 invalid_at」更简单）。

---

## 6. 关键算法

### 6.1 价值闸门（对应需求 1）

两级，先程序化后 LLM，**先用便宜规则砍掉明显噪音**：

1. **prompt 侧**（`buildExtractionPrompt` 改写）：
   - 明确"没有可跨会话复用的事实就返回 `{"memories":[]}`"，禁止为了凑数输出；
   - 负例收敛：寒暄、泛泛的助手自述、一次性调试、git 里已有的代码改动、命令式请求；
   - 要求 `key` 仅用于**唯一身份槽位**（名字、语言偏好、项目根路径……），不要给普通知识编 key；
   - 要求每条给 `importance`：1–2 琐碎、5 常规、8–10 身份/长期约定（对齐 Generative Agents 的锚点）。
2. **程序化侧**：
   - `importance < config.minImportance`（默认 4）→ 丢弃；
   - `durability === 'ephemeral'` 且没给 `expiresInDays` → 落默认 TTL（`defaultEphemeralTtlDays`，默认 14）；
   - `category === 'preference' | profile` → 强制 `durability='durable'`、`pinned=1`（身份事实免疫过期，对应 §3 的「结构分层」）。

### 6.2 关系决策 reconciler（对应需求 2）

新增 `packages/core/src/memory/reconciler.ts`，两段式：

**（a）确定性 upsert（命中 key，零 LLM）**
```
if (candidate.key && await store.getByKey(candidate.key)) {
  → update(existing.id, { content, description, keywords, importance, updatedAt })
  → 若内容矛盾且 key 是单值槽位，直接覆盖，无需 LLM
}
```
这一条直接、可靠地解决「更新我的名字」：`profile.name` 是唯一 key，新值原子覆盖旧值，**不依赖模型自己去改库**。

**（b）LLM 关系决策（未命中 key）**
1. 邻居取回：`store.search(candidate.title + keywords, { category, limit: K })`（现有 FTS5/BM25），再并入标题编辑距离近似项；无邻居 → 直接 `add`，**跳过 LLM**（省一次调用）。
2. 一次 LLM 调用（role=`extractor`，temp 0），工具 schema：
   ```json
   { "op": "add|update|supersede|merge|noop",
     "targetId": "已有记忆 id（update/supersede/merge 必填）",
     "content": "合并后的正文（update/merge 时给出完整新正文）",
     "reason": "一句话" }
   ```
3. 执行语义（**永不硬删**）：
   - `update`：`update(targetId, …)`，`importance` 取 max(old,new)；
   - `supersede`（矛盾）：新记忆入库为 `active`；旧记忆 `status='superseded'`、`valid_to=now`、`superseded_by=新id`；
   - `merge`（近重复）：保留一条 canonical（`importance` 更高者），另一条 `status='merged'`、`superseded_by=canonical.id`；
   - `noop`：丢弃（这是**新增的价值闸门**：LLM 认为没新信息）。
4. 程序化兜底（不能只信 LLM）：
   - `op` 需要 `targetId` 但不在候选邻居集合内 → 降级为 `add`；
   - 归一化标题已存在 → 强制 `update` 而非 `add`；
   - `supersede` 的比例异常（单次占比 > 50%）→ 全部降级为 `add` 并告警（防模型大清洗）。

**（c）成本控制**
- 只有候选 ≥1 且存在邻居才发起 LLM 决策；
- 一次调用处理本批次全部候选（批量），不是每条一次；
- 全部候选都命中 key 时，整段不需要 LLM。

### 6.3 时效与衰减（对应需求 3）

**过期（照搬 Mem0 契约）**：
- `expires_at` 为 UTC ISO 时间；**NULL = 永久**；
- 语义是**隐藏不是删除**：`listActive/search/inject` 过滤掉已过期的；`get(id)` 仍可取；清空 `expires_at` 即恢复；
- 解析失败 fail-open（当永久）；
- `pinned=1` 或 `durability='durable'` 的行**忽略 expires_at**。

**衰减（照搬 Mem0 Decay：只影响排序，永不过滤）**：
```
recency = 0.5 ^ (daysSince(last_accessed_at ?? created_at) / halfLifeDays)   // halfLifeDays 默认 30
retention = clamp(recency * (1 + min(access_count, 20) / 20), 0.3, 1.5)      // 0.3× ~ 1.5× 有下限
```

**超量淘汰（存储上限，软删除）**：
- `maxActiveMemories`（默认 500）超限时，按 `retention × importance` 升序，把尾部 `status='archived'`；
- 永不删除行，永不删 `pinned`。

**维护任务**：
- 新增 `MemoryMaintainer`（core），由 server 挂到「daemon 空闲 / 定时任务」触发（复用现有 scheduler），**不进 turn 关键路径**；
- 职责：`expire due` → 标 `status='expired'`（或只依赖查询过滤，二者取一，建议只过滤、不写状态，减少写放大）；超量淘汰；可选聚类摘要（P3）。

> 设计警告（来自研究）：反复用 LLM **原地重写**记忆会让有用的记忆变坏。所以摘要类产出必须是**旁挂的派生行**（`category='summary'` 或 `derived_from` 字段），原始行保留。

### 6.4 注入排序（`MemoryInjector` 改造）

```
候选 = store.listForInjection(now, { includeExpired:false })
score = w_r·retention + w_i·(importance/10) + w_v·relevance(userInput)   // w 默认 all=1，min-max 归一化
输出顺序：pinned/durable 常驻层（不参与截断） → 其余按 score 降序
截断：maxItems + maxTokens（保持现有上限语义）
注入后：store.touch(ids, now)   // 喂给衰减
```
把现有 `injectMode='all'|'relevant'` 扩成 `'all'|'relevant'|'ranked'`，默认 `ranked`，保留 `all` 兼容旧测试（[injector.test.ts](../packages/core/tests/memory/injector.test.ts)）。

---

## 7. 接线点（文件清单）

**core**
- `src/types/memory.ts`：枚举 + 接口 + extraction schema 扩展
- `src/storage/db.ts`：新增 `migrateV8ToV9`，`SCHEMA_VERSION` → 9
- `src/storage/memory-store.ts`：实现 `getByKey/upsertByKey/touch/supersede/expireDue/listForInjection`
- `src/core/ports.ts`：`MemoryStore` 端口扩展（`MemorySearchOptions` 加 `includeExpired/includeSuperseded`）
- `src/memory/extractor.ts`：prompt 与解析升级
- `src/memory/reconciler.ts`（新）：关系决策
- `src/memory/injector.ts`：ranked 排序 + touch
- `src/memory/maintainer.ts`（新）：过期/淘汰
- `src/types/router.ts`：可选加 `'embedding'` 角色（P3）

**server**
- `src/config.ts`：`MemoryConfig` 加字段（表见 §8）
- `src/index.ts`：env 覆盖（`YO_MEMORY_*`）
- `src/session-manager.ts`：`extractPending` 改为「extract → gate → reconcile」，事件载荷带操作计数
- `src/routes/memories.ts`：列表默认 `latest_only=true`；加 `?include=superseded,expired`；`POST /extract` 语义不变
- `src/storage/schema.ts` + `migrate.ts` + `postgres.ts`：Postgres 同步

**web**
- `components/Memory/MemoryManager.tsx`：显示 `importance`/`expiresAt`/`status`，支持 pin 与「清空过期时间」
- `features/panels/MemoryPanel.tsx`：识别新增事件 `memory_reconciled`（op 计数）

**事件与可观测**
- 保留 `memory_extracted`；新增 `memory_reconciled`（`{add,update,supersede,merge,noop}` 计数）——用于 §8 的阈值调参。

---

## 8. 配置（`MemoryConfig` 新增，全部有默认值）

| 字段 | 默认 | 含义 |
|---|---|---|
| `minImportance` | 4 | 低于此重要度不落库 |
| `enableReconcile` | true | 关闭即退化为「带 key upsert 的 ADD」 |
| `reconcileCandidateLimit` (K) | 10 | 关系决策取多少条邻居（对齐 Mem0 s=10） |
| `defaultEphemeralTtlDays` | 14 | ephemeral 且未给 TTL 时的默认过期 |
| `durableCategories` | `['preference','profile']` | 强制 durable + pinned 的类别 |
| `decayHalfLifeDays` | 30 | 衰减半衰期 |
| `maxActiveMemories` | 500 | 超量淘汰阈值 |
| `injectMode` | `'ranked'` | `all/relevant/ranked` |
| `injectWeights` | `{recency:1,importance:1,relevance:1}` | GA 式打分权重 |

env 覆盖沿用 [index.ts:225-232](../packages/server/src/index.ts) 的 `YO_MEMORY_*` 风格。

---

## 9. 分期与验收

### P0 —— 数据模型 + 确定性 upsert + 过期过滤（1–2 天，解决 3 条需求的 80%）
1. schema v9 + 双边存储 + 类型/端口；
2. extractor 输出 `importance/durability/key/expiresInDays`；
3. 价值阈值过滤；
4. 命中 key 的确定性 `update`；
5. `listActive/search/inject` 过滤过期。

**验收**：同一 `key='profile.name'` 连续写入三次 → 库里恒 1 行且内容为最后一次；`importance=2` 的候选不落库；`expires_at` 过期后不注入但 `GET /memories` 仍可见（`include_expired`）。

### P1 —— 关系决策 reconciler
- 邻居取回 + 一次 LLM 的 add/update/supersede/merge/noop + 程序化兜底；
- 新增 `memory_reconciled` 事件与面板展示。

**验收**：先存「语言偏好=中文」，再对话「以后都用英文」→ 断言旧行 `status='superseded'` 且 `superseded_by` 指向新行、默认列表只返回新行；重建出上一轮真实场景的那个重复 bug 用例并断言不再重复。

### P2 —— 衰减、touch、淘汰、维护任务
- `touch` + `retention` 排序 + `maxActiveMemories` 淘汰 + 定时 `expire` 扫描。

**验收**：注入后 `access_count` +1；人为造 600 行后淘汰至 ≤500 且 `pinned` 全留；关闭 `pinned` 的旧身份事实仍能排进 top-N（衰减下限 0.3×）。

### P3（可选）—— 语义检索与聚类摘要
- 加 `embedding` 角色；邻居取回改「BM25 + 向量」混合，阈值只卡向量分（对齐 Mem0 scoring.py）；
- 定时任务产出**旁挂**的摘要行，原始行不动。

---

## 10. 风险与取舍

1. **模型直接改库的旁路**：当前 `data/yo-harness.db` 被模型用 `shell+sqlite3` 直接改（见上一轮分析）。P0 落地后应同时提供 **`memory` 工具**（走 `MemoryStore`）并在 system prompt 里说明，否则模型仍可能绕过去，导致去重/过期逻辑失效。
2. **不要原地重写**：摘要/合并一律旁挂派生行，保留原始行（研究里的经验性警告）。
3. **双后端同步成本**：SQLite 与 Postgres 都要改，P0 就要把契约测试（[contract.test.ts](../packages/server/tests/storage/contract.test.ts)）扩到新方法。
4. **阈值不要抄**：没有任何厂商公布 NOOP 比例，Mem0 也提醒 v3 分数口径变了。用 `memory_reconciled` 计数 + 一个自建标注集来调 `minImportance` / K / 衰减半衰期，别直接搬数字。
5. **成本**：reconciler 每批一次 LLM 调用。没有邻居时跳过；全命中 key 时零调用；必要时用 `enableReconcile=false` 退化为纯 upsert。

---

## 附录 A 参考

- Mem0 论文（extract + ADD/UPDATE/DELETE/NOOP，m=10/s=10）：https://arxiv.org/html/2504.19413v1
- Mem0 提取与关系判定 prompt：https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py
- Mem0 混合检索打分与阈值：https://github.com/mem0ai/mem0/blob/main/mem0/utils/scoring.py
- Mem0 v3 迁移（转 ADD-only、阈值口径变化）：https://docs.mem0.ai/migration/platform-v2-to-v3
- Mem0 Dream（Supersede/Merge/Synthesis，不删除）：https://docs.mem0.ai/platform/features/dream
- Mem0 Memory Expiration（隐藏不删、空=永久、fail-open）：https://docs.mem0.ai/platform/features/memory-expiration
- Mem0 Memory Decay（0.3×–1.5× 排序偏置、永不过滤）：https://docs.mem0.ai/platform/features/memory-decay
- Generative Agents（1–10 importance、0.995^h 衰减、α 全 1）：https://ar5iv.labs.arxiv.org/html/2304.03442
- Zep / Graphiti 论文（双时态、invalidate 规则、社区摘要）：https://ar5iv.labs.arxiv.org/html/2501.13956
- Graphiti 时间失效实现：https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py
- Letta memory blocks / archival：https://docs.letta.com/v1-sdk/memory/memory-blocks
- MemGPT 分层与递归摘要：https://ar5iv.labs.arxiv.org/html/2310.08560
- A-MEM（should_evolve / strengthen / update_neighbor）：https://arxiv.org/abs/2502.12110
- LangMem（显式 enable_inserts/deletes、结构化 schema）：https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/
- MemoryBank（R=e^(−t/S)，S 随回忆 +1）：https://ar5iv.labs.arxiv.org/html/2305.10250
- Cognee ECL（add/cognify/memify）：https://www.cognee.ai/how-cognee-builds-ai-memory
- 背景合成会破坏记忆的警示：https://arize.com/blog/two-labs-started-dreaming-and-they-built-two-different-architectures/
