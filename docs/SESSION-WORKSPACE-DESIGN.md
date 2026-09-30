# yo-harness 会话管理与工作区设计文档

> 版本 v1.0 · 2026-09-30 · 状态：待评审
> 范围：会话（Session）完整增删改查、命名策略、工作区（Workspace）机制
> 覆盖层次：core（端口 + 存储）、server（API + 权限）、web（状态 + UI）、cli（本地模式对齐）
> 关联文档：docs/UI-REDESIGN.md（前端 IA/组件规范）、docs/CHAT-DISPLAY-REDESIGN.md（对话区 Turn 化）

## 目录

1. 背景与目标
2. 现状盘点
3. 领域模型与术语
4. 数据模型与迁移
5. 核心域端口（core/ports.ts）
6. 存储实现
7. 服务端 REST API
8. 命名与自动标题策略
9. 归档与删除语义
10. 工作区机制
11. 权限（RBAC）
12. 前端设计
13. CLI 适配
14. WebSocket 与事件影响
15. 兼容性与迁移
16. 实施路线图
17. 测试策略
18. 风险与开放问题

---

## 1. 背景与目标

### 1.1 背景

当前 yo-harness 的会话管理只有「能跑通」的最小形态：

- 会话只有 create / listRecent / touch / updateTitle 四个存储操作，无通用更新、无归档、无真正删除；
- 服务端「删除」用 updateTitle(id, '__deleted__') 的 hack 实现软删，events / checkpoints / tasks 等关联数据全部残留；
- 命名只在 CLI 本地模式有一条自动标题逻辑（首条 user_input 截取 60 字符），Server 模式完全没有自动命名；
- Web 侧栏的「重命名 / 置顶 / 归档」菜单项均为「开发中」占位，无法自定义会话名；
- 没有「工作区」概念，会话是全局平铺的，按时间分组（Today / Yesterday / …）无法满足按项目、按主题组织会话的需求。

### 1.2 目标

1. 完整 CRUD：会话支持创建、查询（列表 / 详情 / 搜索 / 过滤 / 分页）、更新（重命名 / 移动工作区 / 置顶 / 归档）、删除。
2. 命名：新建会话默认以「首个问题的前几个字符」作为名称，用户可随时自定义改名；改名后不被自动命名覆盖。
3. 工作区：支持工作区的增删改查；一个工作区下可容纳多个会话；会话可选绑定工作区，也允许完全不绑定（独立会话）。

### 1.3 非目标（本期不做）

- 工作区的嵌套（层级工作区 / 文件夹）。
- 会话/工作区在多个用户之间的分享、协作、权限继承（沿用现有 tenant 级隔离，不做 per-user 隔离）。
- 会话的跨设备同步、导入导出。
- 基于 LLM 的「智能起名」（用摘要模型生成标题）——本期只做确定性截取，预留接口。

---

## 2. 现状盘点

### 2.1 数据表 sessions

SQLite（packages/core/src/storage/db.ts）与 PostgreSQL（packages/server/src/storage/schema.ts / migrate.ts）两侧字段一致：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | UUID |
| title | TEXT NOT NULL DEFAULT '' | 空串表示「无标题」 |
| model | TEXT NOT NULL | 模型 |
| cwd | TEXT NOT NULL | 工作目录 |
| status | TEXT NOT NULL DEFAULT 'active' | active / archived |
| type | TEXT NOT NULL DEFAULT 'interactive' | interactive / background |
| created_at / updated_at | TEXT NOT NULL | ISO 8601 |

缺失：workspace_id、pinned、title_is_custom、软删时间戳等。

### 2.2 领域类型与端口（core/src/core/ports.ts）

~~~ts
export interface Session {
  id: string;
  title: string;
  model: string;
  cwd: string;
  status: 'active' | 'archived';
  type: 'interactive' | 'background';
  createdAt: string;
  updatedAt: string;
}

export interface SessionStore {
  create(input: { model: string; cwd: string; title?: string; type?: 'interactive' | 'background' }): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  listRecent(limit: number): Promise<Session[]>;
  touch(id: string): Promise<void>;
  updateTitle(id: string, title: string): Promise<void>;
}
~~~

### 2.3 服务端路由（server/src/routes/sessions.ts）

| 方法 | 路径 | 现状 |
| --- | --- | --- |
| POST | /api/v1/sessions | 创建，支持 title/model/cwd |
| GET | /api/v1/sessions | 仅 limit，内部 listRecent（只返回 active） |
| GET | /api/v1/sessions/:id | 详情 |
| DELETE | /api/v1/sessions/:id | closeSession() + updateTitle(id, '__deleted__') 软删 hack |

### 2.4 前端

- web/src/api/client.ts：Session 类型只有 id/title/model/cwd/createdAt/updatedAt（缺 status/type），api.sessions 只有 list/get/create/delete/...
- web/src/stores/session.ts：loadSessions/selectSession/createSession/deleteSession/sendMessage/addEvent。
- web/src/components/Sidebar/Sidebar.tsx：New Session + 搜索 + 按时间分组；无工作区。
- web/src/components/Sidebar/SessionItem.tsx：菜单含「重命名 / 置顶 / 归档 / 复制链接」均为 toast('...开发中') 占位，仅「删除」可用。

### 2.5 CLI

cli/src/cli/runtime.tsx 的 launch() 内已有自动标题：

~~~ts
const onFirstInput = (envelope: EventEnvelope): void => {
  if (envelope.payload.type !== 'user_input') return;
  bus.off('event', onFirstInput);
  if (session.title.length > 0) return; // 已有标题不覆盖
  const title = envelope.payload.content.replace(/\s+/g, ' ').trim().slice(0, 60);
  void sessionStore.updateTitle(session.id, title).catch(...);
};
~~~

该逻辑只在 CLI 装配层，Server 模式（session-manager.ts）没有对应实现；截取长度硬编码 60，无词边界处理。

---

## 3. 领域模型与术语

| 术语 | 定义 |
| --- | --- |
| 会话 Session | 一次（可恢复的）多轮对话，事件溯源落库。 |
| 工作区 Workspace | 会话的组织容器，可选。一个会话至多属于一个工作区。 |
| 独立会话 Standalone | workspaceId = null 的会话，不属于任何工作区。 |
| 自动标题 | 由首个 user_input 确定性截取生成的标题。 |
| 自定义标题 | 用户显式设置（创建时或改名）的标题，不再被自动命名覆盖。 |
| 归档 Archive | 可逆的「移出默认列表」操作（status = 'archived'）。 |
| 删除 Delete | 不可逆的物理删除，级联清理关联数据。 |

约束（不变量）：

1. 一个会话的 workspace_id 要么为 NULL（独立），要么指向一个存在的工作区。
2. 删除工作区默认不删除其会话，而是把会话「解绑」为独立会话（workspace_id → NULL）。
3. 自动标题只在 title = '' 且 title_is_custom = false 时触发一次。

---

## 4. 数据模型与迁移

### 4.1 新增表 workspaces

~~~sql
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT,                  -- 可选的强调色（hex，如 '#4f8cff'）
  icon        TEXT,                  -- 可选的图标名（预留）
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_workspaces_sort ON workspaces (sort_order, created_at);
~~~

### 4.2 sessions 表变更

~~~sql
ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN title_is_custom INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_sessions_workspace ON sessions (workspace_id, updated_at DESC);
CREATE INDEX idx_sessions_status ON sessions (status, updated_at DESC);
~~~

- workspace_id：NULL = 独立会话；ON DELETE SET NULL 保证删工作区时自动退化为独立会话。
- pinned：置顶标记，列表排序时置顶项排前（pinned DESC, updated_at DESC）。
- title_is_custom：布尔，1 表示用户显式命名。

### 4.3 迁移版本

- SQLite：packages/core/src/storage/db.ts 的 SCHEMA_VERSION 由 '4' 升为 '5'，新增 migrateV4ToV5(db)。
- PostgreSQL：packages/server/src/storage/schema.ts 新增 workspaces 表与 sessions 新列；packages/server/src/storage/migrate.ts 同步新增 CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS（幂等）。

PostgreSQL 迁移需注意 ADD COLUMN IF NOT EXISTS 不校验类型，正式方案建议在 migrate.ts 中按「是否存在列」判断后追加，与现有 PRAGMA table_info 判断思路一致（见 db.ts 的 v2→v3 迁移写法）。

---

## 5. 核心域端口（core/ports.ts）

### 5.1 类型扩展

~~~ts
export interface Session {
  id: string;
  title: string;
  model: string;
  cwd: string;
  status: 'active' | 'archived';
  type: 'interactive' | 'background';
  workspaceId: string | null;
  pinned: boolean;
  titleIsCustom: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** 该工作区下 active 会话数（列表接口返回，非存储字段） */
  sessionCount?: number;
}
~~~

### 5.2 SessionStore 端口

~~~ts
export interface SessionListFilter {
  workspaceId?: string | 'none';      // 'none' = 仅独立会话；缺省 = 全部
  status?: 'active' | 'archived';     // 缺省 = active
  query?: string;                      // 标题/首条消息模糊匹配
  pinned?: boolean;
  limit?: number;                      // 默认 50，上限 200
  offset?: number;
}

export interface SessionUpdate {
  title?: string;                      // 改名
  titleIsCustom?: boolean;             // 改名时置 true
  workspaceId?: string | null;         // 移动/解绑
  pinned?: boolean;                    // 置顶
  status?: 'active' | 'archived';      // 归档/恢复
}

export interface SessionStore {
  create(input: {
    model: string;
    cwd: string;
    title?: string;
    titleIsCustom?: boolean;
    workspaceId?: string | null;
    type?: 'interactive' | 'background';
  }): Promise<Session>;

  get(id: string): Promise<Session | undefined>;

  /** 带过滤/分页的列表（listRecent 的泛化） */
  list(filter?: SessionListFilter): Promise<Session[]>;

  /** 兼容 CLI 的最近 N 个（委托给 list({ status: 'active', limit }） */
  listRecent(limit: number): Promise<Session[]>;

  touch(id: string): Promise<void>;

  update(id: string, patch: SessionUpdate): Promise<Session | undefined>;

  /** 兼容旧调用；等价 update(id, { title, titleIsCustom: true }) */
  updateTitle(id: string, title: string): Promise<void>;

  /** 物理删除 + 级联清理关联数据 */
  delete(id: string): Promise<void>;
}
~~~

> 说明：保留 updateTitle 与 listRecent 是为了兼容 CLI 现有调用与 SqliteSessionStore 在 CLI 的直连用法，避免一次性重写全部调用点；Server 路由新增 update/list/delete 走新方法。

### 5.3 WorkspaceStore 端口（新增）

~~~ts
export interface WorkspaceStore {
  create(input: {
    name: string;
    description?: string;
    color?: string;
    icon?: string;
    sortOrder?: number;
  }): Promise<Workspace>;

  get(id: string): Promise<Workspace | undefined>;

  update(id: string, patch: Partial<Pick<Workspace,
    'name' | 'description' | 'color' | 'icon' | 'sortOrder'>>): Promise<Workspace | undefined>;

  /** 删除工作区；其下会话 workspace_id → NULL（不删会话） */
  delete(id: string): Promise<void>;

  list(): Promise<Workspace[]>;
}
~~~

### 5.4 标题派生纯函数（新增 core/src/utils/title.ts）

~~~ts
export interface DeriveTitleOptions { maxLength?: number; }

export function deriveTitle(text: string, opts: DeriveTitleOptions = {}): string {
  const max = opts.maxLength ?? 40;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return '';
  if (normalized.length <= max) return normalized;
  // 在 max 附近寻找最近的空白/标点作为断点，避免截断半个词
  const window = normalized.slice(0, max + 1);
  const cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf('，'),
    window.lastIndexOf('。'), window.lastIndexOf('？'), window.lastIndexOf('！'));
  const end = cut > max * 0.5 ? cut : max;
  return normalized.slice(0, end).trim() + '…';
}
~~~

触发规则统一收敛到一处（见 §8），CLI 与 Server 都调用同一函数，保证命名行为一致。

---

## 6. 存储实现

### 6.1 SQLite（core/src/storage/session-store.ts + 新增 workspace-store.ts）

- SqliteSessionStore：补全 update / list / delete；list 用动态 SQL 拼接 WHERE（用参数绑定而非字符串拼接，workspaceId='none' 转 workspace_id IS NULL）。
- delete 在一个事务内执行级联清理（见 §9.2 的清理矩阵）。
- 新增 SqliteWorkspaceStore，list() 用 LEFT JOIN sessions 计算 sessionCount：

~~~sql
SELECT w.*, COUNT(s.id) AS session_count
FROM workspaces w
LEFT JOIN sessions s ON s.workspace_id = w.id AND s.status = 'active'
GROUP BY w.id
ORDER BY w.sort_order ASC, w.created_at ASC;
~~~

- 装配层：SqliteBackend 增加 readonly workspaces 字段并构造。

### 6.2 PostgreSQL（server/src/storage/postgres.ts + schema.ts）

- createTenantSchema() 新增 workspaces 表，sessions 表新增三列与索引。
- PostgresSessionStore 同步补全 update / list / delete（用 drizzle 的 and/or/eq/isNull/ilike + limit/offset）。
- 新增 PostgresWorkspaceStore。
- workspaces 表位于每个租户 schema 内 → 天然租户隔离，无需额外 tenantId 列。

---

## 7. 服务端 REST API

所有接口沿用 /api/v1 前缀、sessions:read/write 或新增的 workspaces:read/write 权限（§11），错误返回统一 { error: string }。

### 7.1 工作区

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | /api/v1/workspaces | workspaces:write | 创建，body：{ name, description?, color?, icon? } |
| GET | /api/v1/workspaces | workspaces:read | 列表，返回项含 sessionCount |
| GET | /api/v1/workspaces/:id | workspaces:read | 详情 |
| PATCH | /api/v1/workspaces/:id | workspaces:write | 更新 { name?, description?, color?, icon?, sortOrder? } |
| DELETE | /api/v1/workspaces/:id | workspaces:write | 删除工作区，会话解绑；?purge=true 时连同会话级联删除 |

### 7.2 会话

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | /api/v1/sessions | sessions:write | 创建，body 扩展：{ title?, workspaceId?, model?, cwd? } |
| GET | /api/v1/sessions | sessions:read | 列表，query：workspaceId（含 none）、status、q、pinned、limit、offset |
| GET | /api/v1/sessions/:id | sessions:read | 详情 |
| PATCH | /api/v1/sessions/:id | sessions:write | 更新，body：{ title?, workspaceId?, pinned?, status? } |
| DELETE | /api/v1/sessions/:id | sessions:write | 物理删除 + 级联清理 |

POST /api/v1/sessions 创建逻辑要点：

~~~ts
const workspaceId = body.workspaceId ?? null;      // null = 独立会话
if (workspaceId !== null) {
  const ws = await storage.workspaces.get(workspaceId);
  if (!ws) return c.json({ error: 'workspace not found' }, 400);
}
const titleIsCustom = body.title !== undefined && body.title.trim() !== '';
const session = await storage.sessions.create({
  model: body.model ?? 'default',
  cwd: body.cwd ?? process.cwd(),
  title: body.title ?? '',
  titleIsCustom,
  workspaceId,
  type: 'interactive',
});
~~~

PATCH 重命名时由服务端强制 titleIsCustom = true；workspaceId 变更时校验目标工作区存在。

---

## 8. 命名与自动标题策略

### 8.1 命名来源

| 场景 | title | title_is_custom |
| --- | --- | --- |
| 新建（未命名） | ''（界面显示「新会话」） | 0 |
| 新建（显式命名） | 用户输入 | 1 |
| 首条消息后（未命名） | deriveTitle(首条 user_input) | 0 |
| 用户改名 | 用户输入 | 1 |

### 8.2 自动标题触发（统一收敛到 Server 与 CLI）

触发条件：会话首次落库 user_input 事件，且 title = '' 且 title_is_custom = 0。

- Server：在 SessionManager.getOrCreate() 的 sink 里，或在 EventBus 订阅中检测首个 user_input，调用 sessionStore.update(id, { title: deriveTitle(content), titleIsCustom: false })。推荐放在 session-manager.ts 的 sink 附近，与现有 wsHub.broadcast 同层，避免侵入 AgentLoop。
- CLI：把 runtime.tsx 里硬编码的 slice(0, 60) 替换为 deriveTitle(content)，其余触发逻辑不变。

### 8.3 规则

1. 归一化：折叠所有连续空白为单个空格、去首尾空白。
2. 截断：默认 40 字符；超长时优先在空白或中英文标点处断句，否则硬截断并追加 …。
3. 不改名不覆盖：title_is_custom = 1 后任何自动命名都不再写入。
4. 空消息：deriveTitle 返回空串时保持「未命名」，不写入。

---

## 9. 归档与删除语义

### 9.1 归档（Archive，可逆）

- PATCH /api/v1/sessions/:id with { status: 'archived' }；恢复用 { status: 'active' }。
- 归档后从默认列表隐藏（status 默认过滤为 active），通过 GET /sessions?status=archived 查看。
- 与「删除」分离，UI 上「归档」不弹强确认，「删除」弹二次确认。

### 9.2 删除（Delete，不可逆）

物理删除需在同一事务内级联清理：

| 关联数据 | 处理 | 理由 |
| --- | --- | --- |
| events | 删除该 session 全部事件 | 事件只属于该会话 |
| checkpoints / checkpoint_files | 删除该 session 的检查点及其文件 | 只属于该会话 |
| memories.source_session_id | 置 NULL（记忆本身保留） | 记忆跨会话持久化，删除会话不应删记忆 |
| tasks | 默认置 NULL 或阻止删除（见开放问题） | 后台任务与 session 弱关联 |

SQLite 的 events、checkpoints 有 FK，checkpoint_files 引用 checkpoints，删除顺序：checkpoint_files → checkpoints → events → sessions。memories.source_session_id 无 FK 约束，显式 UPDATE ... SET source_session_id = NULL。tasks.session_id 无 FK，需显式处理（推荐：若存在 running 任务则返回 409 阻止删除，否则 SET NULL）。

> 说明：现有「删除 = 改 title 为 __deleted__」的 hack 一并移除；SessionManager.closeSession(id) 保留（负责中断活跃 loop 与审批队列），在路由里先 closeSession 再 storage.sessions.delete(id)。

---

## 10. 工作区机制

### 10.1 关系

~~~
Tenant（多租户 schema）
└── Workspace 1..N
    ├── Session A
    ├── Session B
    └── ...
└── Session X（独立，workspace_id = NULL）
~~~

- 工作区与会话是可选的一对多：workspace_id 可空。
- 独立会话与工作区会话在存储上平等，仅在 UI 分组上不同。
- 多租户下工作区随 tenant schema 自动隔离；单租户 SQLite 下为实例级全局（与现有 sessions 的隔离粒度一致）。

### 10.2 工作区操作语义

- 新建：name 必填（非空、去空白、≤ 64 字符），description/color/icon/sortOrder 可选。
- 重命名/改样式：PATCH，空 name 拒绝（400）。
- 删除：
  - 默认（purge=false）：其下会话 workspace_id → NULL，成为独立会话，会话数据不丢。
  - purge=true：级联删除其下全部会话（复用 §9.2 的级联清理），需 UI 二次确认并明确提示数量。
- 移动会话：PATCH /sessions/:id 的 workspaceId 字段，null 表示解绑为独立。

### 10.3 排序

- 会话列表排序：pinned DESC, updated_at DESC（置顶优先，其余按最近活跃）。
- 工作区排序：sort_order ASC, created_at ASC；UI 支持拖拽调序（P0 可先不做，sort_order 预留）。

---

## 11. 权限（RBAC）

server/src/auth/rbac.ts 的 Permission 联合类型与 ROLE_PERMISSIONS 增加：

~~~ts
| 'workspaces:read'
| 'workspaces:write'

viewer:  [...现有, 'workspaces:read']
member:  [...现有, 'workspaces:read', 'workspaces:write']
admin:   [...现有, 'workspaces:read', 'workspaces:write', ...]
~~~

- 工作区路由 app.use('*', requirePermission('workspaces:read'))，写操作用 workspaces:write。
- 会话 PATCH（移动工作区 / 归档）沿用 sessions:write。
- viewer 只读，可看工作区与会话但不能改。

---

## 12. 前端设计

### 12.1 API 客户端（web/src/api/client.ts）

~~~ts
export interface Session {
  id: string;
  title: string | null;
  model: string;
  cwd: string;
  status: 'active' | 'archived';
  type: 'interactive' | 'background';
  workspaceId: string | null;
  pinned: boolean;
  titleIsCustom: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  sessionCount?: number;
  createdAt: string;
  updatedAt: string;
}
~~~

扩展与新增：

~~~ts
api.workspaces = {
  list: () => fetchJson<{ workspaces: Workspace[] }>('GET', '/api/v1/workspaces'),
  create: (input) => fetchJson<{ workspace: Workspace }>('POST', '/api/v1/workspaces', input),
  update: (id, patch) => fetchJson<{ workspace: Workspace }>('PATCH', '/api/v1/workspaces/' + id, patch),
  delete: (id, purge = false) => fetchJson<void>('DELETE', '/api/v1/workspaces/' + id + '?purge=' + purge),
};

api.sessions = {
  list: (filter?) => fetchJson<{ sessions: Session[] }>('GET', '/api/v1/sessions' + qs(filter)),
  create: (input: { model?, cwd?, title?, workspaceId? }) => ...,
  update: (id, patch: { title?, workspaceId?, pinned?, status? }) =>
    fetchJson<{ session: Session }>('PATCH', '/api/v1/sessions/' + id, patch),
  delete: (id) => ...,
  // 其余不变
};
~~~

### 12.2 状态（Zustand）

- 新增 stores/workspace.ts：workspaces / isLoading / loadWorkspaces / createWorkspace / renameWorkspace / deleteWorkspace。
- stores/session.ts 扩展：

~~~ts
renameSession(id, title): Promise<void>;          // PATCH title
pinSession(id, pinned): Promise<void>;            // PATCH pinned
archiveSession(id, archived): Promise<void>;      // PATCH status
moveSession(id, workspaceId | null): Promise<void>; // PATCH workspaceId
createSession(opts: { title?, workspaceId?, model?, cwd? }): Promise<Session>;
// deleteSession 改为调用真正的 DELETE；本地同步更新列表
~~~

- useSession() hook 暴露新增 action，供侧栏调用。

### 12.3 侧栏信息架构（Sidebar.tsx）

~~~
Sidebar
├── [ + 新建会话 ]（默认独立会话）
├── [ 搜索会话 / 工作区 ]
├── ── 工作区 ────────────────────
│   ├── ▸ 工作区 A（可折叠；hover 出 ⋯：重命名/新建会话/删除）
│   │     ├── 会话 1
│   │     └── 会话 2
│   └── ▸ 工作区 B
│         └── 会话 3
├── ── 独立会话 ──────────────────
│   ├── 会话 4（无工作区）
│   └── （Today / Yesterday / Older 时间分组，沿用现有分组）
└── footer：用户 / 设置 / 登出
~~~

折叠展开状态用 localStorage 持久化（键 yo-workspace-collapsed）。工作区区块顺序沿用 sort_order，独立会话区块沿用时间分组。

### 12.4 会话项操作（SessionItem.tsx）

将「开发中」占位替换为真实动作：

| 菜单项 | 行为 |
| --- | --- |
| 重命名 | 行内编辑（双击标题或菜单触发），Enter 提交、Esc 取消，提交后 titleIsCustom=true |
| 置顶 / 取消置顶 | pinSession |
| 移动到工作区 | 弹出工作区选择（含「无工作区」），moveSession |
| 归档 | archiveSession(id, true)，Toast 提示可恢复 |
| 复制链接 | 复制 /chat/:id 深链（P0 可选，仍可占位） |
| 删除 | 强确认弹窗 → deleteSession |

### 12.5 工作区对话框（新增 components/Workspace/WorkspaceDialog.tsx）

- 新建/编辑工作区：名称（必填）+ 描述（可选）+ 颜色 swatch（预设 8 色）。
- 删除工作区：二选一 ——「仅删除工作区（会话保留为独立）」/「同时删除全部会话（不可恢复）」，并显示会话数。

### 12.6 关键线框

~~~
┌──────────── SidebarPane 280 ────────────┐
│ [+ 新建会话]           [🔍 搜索…]        │
│                                         │
│ 工作区                          [+ 新建] │
│  ▾ 前端重构                ⋯            │
│    🗨 重构认证模块…        · 2h        │
│    🗨 会话命名方案           · 1h        │
│  ▾ 周报                        ⋯       │
│    🗨 本周进展总结           · 昨天      │
│                                         │
│ 独立会话                                │
│    🗨 帮我调研 tubi…        · 今天      │
│    🗨 (untitled)            · 昨天      │
│                                         │
│ ─────────────────────────────────────── │
│  👤 alice          ⚙️      ⏻          │
└─────────────────────────────────────────┘
~~~

---

## 13. CLI 适配

本地 CLI（local-first）保持「零工作区」的简单心智，本期做最小对齐：

1. 自动标题统一：runtime.tsx 改用 deriveTitle（§8.2），行为与 Server 一致。
2. /sessions 增强（可选）：列表展示 pinned 与工作区归属（若本地也启用工作区存储）。
3. 工作区子命令（P1，可选）：

~~~text
yo workspace ls            # 列出工作区及会话数
yo workspace new <name>    # 新建
yo workspace rm <id>       # 删除（会话解绑）
yo --workspace <id>        # 新建会话并绑定到工作区
yo resume --workspace <id> # 只列出该工作区会话供恢复
~~~

> 若一期仅面向 Server + Web，则 CLI 只做第 1 条，第 2/3 条作为后续增量，不影响数据模型（workspace_id 列对 CLI 透明）。

---

## 14. WebSocket 与事件影响

- 会话重命名/移动/归档/删除是会话元数据变更，不进事件流（events 只承载 agent 动作），因此不需要新增事件类型。
- 删除/归档会话后，前端需在 deleteSession/archiveSession 成功后 wsClient.unsubscribe(id)（与现有 delete 逻辑一致）。
- 工作区操作不涉及 WebSocket。
- 可选增强（非必须）：wsHub.broadcast(sessionId, { type: 'session_updated', ... })，让已打开该会话的其他标签页同步标题；一期可用「列表刷新」替代。

---

## 15. 兼容性与迁移

1. 存量数据：workspace_id 默认 NULL → 现有全部会话自动成为「独立会话」，行为与现状一致（无回归）。
2. title_is_custom 默认 0：存量已命名的会话（如 CLI 曾自动填写的 title）会被视为「非自定义」，但自动命名有 title = '' 前提，不会覆盖已有非空标题，无副作用。
3. 移除软删 hack：迁移后 title='__deleted__' 的脏数据需清洗脚本将其 status 置为 archived 或直接删除；GET /sessions 过滤掉该魔法值。
4. PostgreSQL 幂等迁移：ADD COLUMN IF NOT EXISTS 保证重复执行安全；schema.ts 与 migrate.ts 保持一致。
5. 两端 store 同步：SQLite（core）与 PostgreSQL（server）的 SessionStore 实现需同时补齐新方法，否则 interface.ts 的 StorageBackend 类型会不一致。

---

## 16. 实施路线图

### Phase 1（数据与后端，先行）

1. core/ports.ts：扩展 Session、新增 Workspace/WorkspaceStore、扩展 SessionStore。
2. core/utils/title.ts：deriveTitle + 单测。
3. core/storage/db.ts：schema v5 + migrateV4ToV5。
4. core/storage/session-store.ts：补全 update/list/delete。
5. core/storage/workspace-store.ts：SqliteWorkspaceStore。
6. server/storage/schema.ts + migrate.ts + postgres.ts：同步。
7. server/src/routes/workspaces.ts（新增）+ 改 sessions.ts；app.ts 挂载。
8. server/src/auth/rbac.ts：新增权限。
9. server/src/session-manager.ts：统一自动标题触发。

### Phase 2（前端）

10. web/src/api/client.ts：类型 + api.workspaces + api.sessions.update/list/create 扩展。
11. stores/workspace.ts（新增）+ stores/session.ts 扩展。
12. Sidebar.tsx 工作区分组 + SessionItem.tsx 真实动作（重命名/置顶/归档/移动/删除）。
13. WorkspaceDialog.tsx 新建/编辑/删除确认。
14. Toast / 空态 / 加载态补齐。

### Phase 3（CLI 与打磨）

15. CLI deriveTitle 对齐；可选工作区子命令。
16. 清洗 __deleted__ 脏数据脚本。
17. 端到端联调、回归、文档更新（README、本设计文档）。

---

## 17. 测试策略

- 单元：deriveTitle（空串/超长/中英混排/标点断句/全空白）；SqliteSessionStore 的 list 过滤组合（workspace/status/query/pinned/pagination）、update 改名置 titleIsCustom、delete 级联清理。
- 存储对比：SQLite 与 PostgreSQL 的 SessionStore/WorkspaceStore 用同一份行为测试集（vitest 参数化后端）。
- 路由：Hono 路由测试覆盖工作区 CRUD、会话 PATCH 各分支（改名/移动/归档/非法 workspace 400/无权限 403）、删除的 409（存在 running 任务时）。
- 前端：@testing-library/react 覆盖 SessionItem 菜单动作、WorkspaceDialog 表单校验与删除确认、Sidebar 分组渲染（工作区 + 独立 + 时间）。
- 迁移：v4→v5 迁移对存量库的幂等与数据保全（旧会话全变独立会话）。

---

## 18. 风险与开放问题

1. 删除粒度（Q）：tasks 与会话的级联关系。默认「存在 running 任务则 409 阻止删除，否则 task.session_id 置 NULL」，是否接受？
2. 工作区删除默认值（Q）：默认「解绑不删会话」，是否需要额外「归档工作区」状态（而非直接删除）？
3. 自动标题长度（Q）：默认 40 字符是否合适？是否需要在配置（config.json）暴露 sessionTitleMaxLength？
4. per-user 隔离（Q）：单租户 SQLite 下工作区为实例级全局；若需按用户隔离，需要给 workspaces/sessions 增加 owner_id，本期是否不做？
5. 多标签页同步：元数据变更目前靠刷新，是否需要 session_updated 的 WS 广播（见 §14）。
6. 置顶排序：置顶项之间按 updated_at 还是按「置顶时间」排序，需定稿（建议记录 pinned_at，一期可用 updated_at 近似）。
7. PG 的 ADD COLUMN IF NOT EXISTS 局限：不校验列类型，正式环境建议用 information_schema.columns 判断后追加（迁移脚本需谨慎）。

---

## 附：字段与接口速查

sessions 新列：workspace_id TEXT NULL、pinned INTEGER DEFAULT 0、title_is_custom INTEGER DEFAULT 0

workspaces 表：id / name / description / color / icon / sort_order / created_at / updated_at

会话 REST：POST /sessions、GET /sessions（workspaceId|status|q|pinned|limit|offset）、GET/PATCH/DELETE /sessions/:id

工作区 REST：POST/GET /workspaces、GET/PATCH/DELETE /workspaces/:id（DELETE 支持 ?purge=true）
