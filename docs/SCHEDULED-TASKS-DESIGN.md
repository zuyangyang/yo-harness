# 定时任务（Scheduled Tasks）功能实现文档

> 状态：设计稿（待实现）
> 适用范围：`packages/server`、`packages/web`、`packages/core`（仅类型）
> 关联提交：`refactor(web): remove Tasks (background task) entry and view`

---

## 1. 目的与范围

在 Web UI 中提供「定时任务」能力：用户可以定义一个周期性任务（Prompt + 频率 + 工作区 + 模型 + 输出方式），由服务端在后台到点自动执行一轮无头 Agent，并把结果投递给用户。

本文档是**实现规格**，包含数据模型、调度器、执行路径、API、前端、分阶段计划与验收标准。实现者应按 §11 的阶段推进。

**本文不覆盖**：CLI 侧命令、daemon 的改造（见 §7.7，daemon 冻结即可）、多租户隔离的完整落地（见 §13 开放问题）。

---

## 2. 背景与现状

### 2.1 为什么移除原 Tasks

原「后台任务（daemon）」能力与 server 是两套互不相通的运行时：

| 维度 | daemon（原 Tasks） | server（Web） |
| --- | --- | --- |
| 通信 | 本地 Unix socket `~/.yo-harness/daemon.sock` | HTTP + WS |
| 存储 | `~/.yo-harness/sessions.db` | `YO_SQLITE_PATH`（默认 `data/yo-harness.db`） |
| 创建入口 | 仅 CLI `yo bg` | **无**（只有 list/cancel） |
| 生命周期 | 空闲 5 分钟自动退出 | 常驻 |

因此 Web 的 Tasks 页面只能列出/取消一个「没有任何 server 路径会创建」的表，已提交移除（导航与视图）。**后端 `/api/v1/tasks` 路由与前端 `api.tasks` 保留**，因为本功能将把 `tasks` 表复用为「运行历史」。

### 2.2 为什么在 server 做调度

- server 已具备无头执行能力：`SessionManager` 在服务端持有 `AgentLoop` 并异步执行 `runTurn`，浏览器断开不影响执行（[session-manager.ts](../packages/server/src/session-manager.ts)）。
- 会话已支持持久化的**会话级权限模式** `session.permissionMode`，置为 `full` 即可无审批运行（[ports.ts](../packages/core/src/core/ports.ts) 第 41-42 行）。
- 会话已有 `type: 'interactive' | 'background'` 字段，天然区分定时运行产生的会话。
- server 的 `tasks` 表已建好但无写入方，正好作为运行历史。

**结论**：不新增运行时，复用 `SessionManager` + 现有 `AgentLoop`，只新增「调度」与「投递」两块。

---

## 3. 目标 / 非目标

### 目标（P0）

- 用户可在 Web 创建/编辑/启停/删除一条定时任务。
- 支持「每天 / 每周 / 每月 / 自定义 cron」+ IANA 时区。
- 到点由 server 自动执行一轮无头 Agent，无需人工审批。
- 每次运行有记录（状态、开始/结束时间、摘要、错误），Web 可查看。
- 结果至少有一种投递方式：写入工作区报告文件 + 站内未读通知。

### 非目标（P0 明确不做）

- 秒级精度调度（最小粒度 1 分钟）。
- 工作流编排 / DAG / 任务依赖。
- 多实例横向扩展下的严格 exactly-once（P2 再做分布式锁）。
- 移动端推送、邮件/IM 投递（P1）。
- 多租户严格隔离（P2，见 §13）。

---

## 4. 术语

| 术语 | 含义 | 存储 |
| --- | --- | --- |
| Schedule / 定时任务 | 任务定义（做什么、何时做） | `scheduled_tasks` 表 |
| Run / 运行 | 一次执行实例 | `tasks` 表（扩展两列） |
| Session / 会话 | 一次运行对应的 Agent 会话，含完整事件流 | `sessions` / `events` 表 |
| Tick | 调度器周期性扫描到期任务的循环 | 内存 |
| 投递 | 把运行结果送到用户可见处（文件/通知/webhook） | 见 §7.5 |

---

## 5. 总体架构

```
                    ┌──────────────────────────────────────────────┐
                    │                server 进程                     │
                    │                                                │
  Web UI ──HTTP──▶  │  /api/v1/schedules (CRUD)                      │
   │                │        │                                       │
   │                │        ▼                                       │
   │                │  ScheduledTaskScheduler ──tick(30s)──▶ 到期扫描 │
   │                │        │                                       │
   │                │        ▼                                       │
   │                │  create session(type=background,              │
   │                │     permissionMode=full, cwd)                 │
   │                │        │                                       │
   │                │        ▼                                       │
   │                │  SessionManager.sendMessage(sessionId, prompt) │
   │                │        │  (复用 AgentLoop)                     │
   │                │        ▼                                       │
   │                │  运行结束 → 写 tasks 行 + 投递 + 算下次时间    │
   │                │        │                                       │
   Web UI ◀──WS────│        └─ wsHub.broadcast(task.completed)        │
                    └──────────────────────────────────────────────┘
                                      │
                                      ▼
                          scheduled_tasks / tasks / sessions / events
```

---

## 6. 数据模型

### 6.1 新增表 `scheduled_tasks`

在 [schema.ts](../packages/server/src/storage/schema.ts) 中按现有 drizzle 风格新增：

```ts
const scheduledTasks = schema.table(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(),
    /** 预留多租户；当前单租户模式写入 null */
    tenantId: text('tenant_id'),
    name: text('name').notNull(),
    /** 发给 Agent 的完整指令 */
    prompt: text('prompt').notNull(),
    /** 标准 cron 表达式，5 或 6 段（含秒）；统一按 UTC 计算，展示时换算时区 */
    cron: text('cron').notNull(),
    /** IANA 时区，如 Asia/Shanghai */
    timezone: text('timezone').notNull().default('UTC'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** 目标工作区；null = 独立会话（cwd 取服务端默认工作目录） */
    workspaceId: text('workspace_id'),
    /** 运行目录；缺省由 workspaceId 推导 */
    cwd: text('cwd'),
    /** 形如 "providerId/modelId"；null = 全局默认模型 */
    model: text('model'),
    /** 无头运行必须为 full，避免无人审批时阻塞 */
    permissionMode: text('permission_mode').notNull().default('full'),
    /** 允许的工具白名单 JSON 数组；null = 全部工具（见 §7.4） */
    allowedTools: text('allowed_tools'),
    /** 运行预算覆盖，null = 用全局 budget */
    maxSteps: integer('max_steps'),
    maxTokens: integer('max_tokens'),
    maxDurationMs: integer('max_duration_ms'),
    /** 结果投递方式 */
    outputKind: text('output_kind').notNull().default('report'),
    /** report 时为目标目录；webhook 时为 URL */
    outputTarget: text('output_target'),
    /** 上一次未跑完时下一次到点怎么办 */
    overlapPolicy: text('overlap_policy').notNull().default('skip'),
    /** 服务端停机错过触发怎么办 */
    catchUpPolicy: text('catch_up_policy').notNull().default('skip'),
    nextRunAt: text('next_run_at').notNull(),
    lastRunAt: text('last_run_at'),
    lastRunId: text('last_run_id'),
    lastStatus: text('last_status'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('scheduled_tasks_due_idx').on(table.enabled, table.nextRunAt),
  ],
);
```

**枚举取值**

| 字段 | 取值 | 默认 |
| --- | --- | --- |
| `permissionMode` | `full`（固定，P0 不允许改） | full |
| `outputKind` | `report` \| `notification` \| `webhook` \| `none` | report |
| `overlapPolicy` | `skip` \| `queue` \| `allow` | skip |
| `catchUpPolicy` | `skip` \| `run_once` \| `grace` | skip |

### 6.2 扩展 `tasks` 表（运行历史）

在现有 `tasks` 表上新增两列（现有列见 [schema.ts](../packages/server/src/storage/schema.ts) 第 119-138 行）：

```ts
  /** 关联的定时任务；null = 手动/CLI 触发 */
  scheduleId: text('schedule_id'),
  /** 触发来源 */
  trigger: text('trigger').notNull().default('manual'), // 'manual' | 'schedule' | 'cli'
```

> 现状注意：`tasks.status` 默认 `'running'`。定时运行应显式写 `'pending'`，启动后更新为 `'running'`。

### 6.3 新增表 `notifications`（P0 投递用）

```ts
const notifications = schema.table(
  'notifications',
  {
    id: text('id').primaryKey(),
    /** 关联会话，点击可跳转到运行详情 */
    sessionId: text('session_id'),
    kind: text('kind').notNull(),          // 'schedule_run' | 'schedule_failed'
    title: text('title').notNull(),
    body: text('body'),
    readAt: text('read_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('notifications_read_idx').on(table.readAt, table.createdAt)],
);
```

### 6.4 迁移

- SQLite / Postgres 后端共用 [schema.ts](../packages/server/src/storage/schema.ts)，迁移脚本在 [migrate.ts](../packages/server/src/storage/migrate.ts)。
- Postgres 后端需同步扩展 [postgres.ts](../packages/server/src/storage/postgres.ts) 的 `PostgresTaskStore`（新增列映射）并新增 `PostgresScheduledTaskStore`。
- 后端接口在 [interface.ts](../packages/server/src/storage/interface.ts) 增加 `scheduledTasks: ScheduledTaskStore`。

### 6.5 新增端口 `ScheduledTaskStore`

建议在 `packages/core/src/core/ports.ts` 定义（与 `TaskStore` 同级），server 两个后端各自实现：

```ts
export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  workspaceId: string | null;
  cwd: string | null;
  model: string | null;
  permissionMode: 'full';
  allowedTools: string[] | null;
  maxSteps: number | null;
  maxTokens: number | null;
  maxDurationMs: number | null;
  outputKind: 'report' | 'notification' | 'webhook' | 'none';
  outputTarget: string | null;
  overlapPolicy: 'skip' | 'queue' | 'allow';
  catchUpPolicy: 'skip' | 'run_once' | 'grace';
  nextRunAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskStore {
  create(input: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt'>): Promise<ScheduledTask>;
  get(id: string): Promise<ScheduledTask | undefined>;
  list(): Promise<ScheduledTask[]>;
  update(id: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask | undefined>;
  delete(id: string): Promise<void>;
  /** enabled=true 且 next_run_at <= at 的任务，按 next_run_at 升序 */
  listDue(at: string): Promise<ScheduledTask[]>;
}
```

---

## 7. 后端设计

### 7.1 模块划分

新增目录 `packages/server/src/scheduler/`：

```
scheduler/
├── index.ts          # 导出 ScheduledTaskScheduler
├── scheduler.ts      # 调度循环（tick / dispatch / 并发守卫）
├── runner.ts         # 单次运行：建 session → sendMessage → 收尾
├── cron.ts           # cron 解析与下次时间计算（封装 cron-parser）
├── deliver.ts        # 结果投递（report / notification / webhook）
└── types.ts          # 内部类型
```

### 7.2 调度器生命周期

```ts
const TICK_MS = 30_000;          // 每 30s 扫描一次
const MAX_CONCURRENT_RUNS = 3;   // 全局并发上限

export class ScheduledTaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();   // scheduleId in-flight
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  async start(): Promise<void> {
    await this.recover();                        // 重启恢复 + 错过补齐
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** CRUD 后调用，热更新内存态；P0 可直接重新查库 */
  async reload(): Promise<void> { /* ... */ }
}
```

**启动流程 `recover()`**

1. 读取所有 `enabled = true` 的记录。
2. 对每条：若 `nextRunAt` 为空或过去时间：
   - `catchUpPolicy = skip` → 直接按 cron 算出**下一个未来时间**写回；
   - `run_once` → 立即标记为待运行并重算下次时间；
   - `grace` → 若错过时间在宽限期（如 1 小时）内则立即补跑，否则跳过。
3. 清理 `status = 'running'` 但进程已重启的僵尸运行：把超时的运行置为 `failed`（`error_message = 'server restarted'`）。

**优雅关闭**：在 [index.ts](../packages/server/src/index.ts) 的 shutdown 流程里调用 `scheduler.stop()`；已开始的运行不强行中断，但需在退出前等待（设最大 30s 等待）。

### 7.3 Tick 与并发 / 重叠

```ts
private async tick(): Promise<void> {
  if (this.ticking) return;         // 防止 tick 重入
  this.ticking = true;
  try {
    const now = new Date().toISOString();
    const due = await this.deps.store.scheduledTasks.listDue(now);
    for (const schedule of due) {
      if (this.deps.inFlightCount() >= MAX_CONCURRENT_RUNS) break;
      void this.dispatch(schedule).catch((err) => this.deps.logger.error(/* ... */));
    }
  } finally {
    this.ticking = false;
  }
}
```

**重叠策略**（同一条 schedule）

- 先算下次时间并**立即写回 `nextRunAt`**（关键：必须在 dispatch 前，避免下一 tick 重复触发）。
- `skip`：若该 schedule 有 in-flight 运行（内存 `running` 或 DB 中 `lastRunId` 对应记录仍为 `running`）→ 本次不执行，记一条 `skipped` 日志。
- `allow`：直接并行执行。
- `queue`：P1 再做持久队列，P0 按 `skip` 处理。

**幂等/多实例**：P0 单实例，靠「先写 nextRunAt + 内存 running 集合」保证不重复触发即可。P2 引入数据库行锁或租约（见 §13）。

### 7.4 执行路径

**核心复用点**：无需新建 runner 运行引擎，直接复用 `SessionManager`。

```ts
async function runSchedule(deps: SchedulerDeps, schedule: ScheduledTask): Promise<RunResult> {
  // 1) 解析工作区 / cwd / 模型
  const workspace = schedule.workspaceId
    ? await deps.storage.workspaces.get(schedule.workspaceId)
    : undefined;
  const cwd = schedule.cwd ?? workspace?.rootPath ?? deps.defaultCwd;
  const model = schedule.model ?? deps.defaultModelLabel();

  // 2) 建运行历史行（tasks）
  const run = await deps.storage.tasks.create({
    description: schedule.name,
    cwd,
    model,
    scheduleId: schedule.id,
    trigger: 'schedule',
    status: 'pending',
  });

  // 3) 建会话：background + full 权限（无审批）
  const session = await deps.storage.sessions.create({
    model,
    cwd,
    title: '[定时] ' + schedule.name + ' · ' + formatDate(new Date(), schedule.timezone),
    titleIsCustom: true,
    workspaceId: schedule.workspaceId ?? null,
    type: 'background',
    permissionMode: 'full',
  });

  // 4) 启动并等待（需要一个完成回调，见 §7.4.1）
  await deps.storage.tasks.updateStatus(run.id, 'running');
  const reason = await deps.sessionManager.sendMessageAndWait(session.id, schedule.prompt);

  // 5) 收尾：取最后一段 assistant_text 作为摘要
  const summary = await extractLastAssistantText(deps.storage.eventStore, session.id);

  const status = reason === 'done' ? 'completed' : reason === 'error' ? 'failed' : 'cancelled';
  await deps.storage.tasks.updateStatus(run.id, status, toEndReason(reason), undefined, summary);

  // 6) 投递
  await deliver(deps, schedule, { sessionId: session.id, summary, status });

  return { runId: run.id, sessionId: session.id, status, summary };
}
```

#### 7.4.1 需要的最小改动：等待一轮结束

现状 [session-manager.ts](../packages/server/src/session-manager.ts) 的 `sendMessage` 立即返回 `{ accepted: true }`，`startTurn` 用 `void` 异步执行。调度器需要知道何时结束。

**推荐改动**（最小侵入）：给 `sendMessage` / `startTurn` 增加可选回调：

```ts
async sendMessage(
  sessionId: string,
  message: string,
  options?: { onSettled?: (reason: TurnEndReason) => void },
): Promise<{ accepted: true }> { /* ... */ }

private async startTurn(sessionId, message, options?): Promise<void> {
  // ...
  void this.runTurn(active, message)
    .then((reason) => options?.onSettled?.(reason))
    .finally(() => { active.running = false; });
}
```

调度器侧包成 Promise：

```ts
sendMessageAndWait(sessionId: string, message: string): Promise<TurnEndReason> {
  return new Promise((resolve) => {
    void this.sendMessage(sessionId, message, { onSettled: resolve });
  });
}
```

> 备选方案：轮询 `eventStore.replay(sessionId)` 直到出现 `turn_completed` 事件。不作为首选——轮询有延迟且需处理异常路径。

**为什么不用 daemon 的 `TaskRunner`**：它是独立于 server 的运行器（自带 sandbox、无 WS 广播、写入不同 DB），复用会让定时运行脱离 server 会话体系，用户无法在 Web 查看完整过程。直接用 `SessionManager` 后，定时运行的会话事件会经 `wsHub` 广播，用户打开该会话即可实时/事后查看全过程。

### 7.4.2 工具白名单（P1）

P0 先不限制工具，靠 sandbox + 预算兜底。P1 按 `allowedTools` 包一层 `ToolResolver` 过滤：

```ts
function withToolAllowlist(resolver: ToolResolver, allow: string[] | null): ToolResolver {
  if (!allow) return resolver;
  const set = new Set(allow);
  return {
    listTools: () => resolver.listTools().filter((t) => set.has(t.name)),
    callTool: (name, args, ctx) =>
      set.has(name) ? resolver.callTool(name, args, ctx) : Promise.reject(new Error('tool not allowed: ' + name)),
  };
}
```

「每日行业调研」推荐白名单：`['web_search', 'web_fetch', 'read_file', 'write_file']`。

### 7.5 结果投递

这是本功能的产品价值所在——**只跑不送达等于没做**。P0 实现前两种：

| outputKind | 行为 |
| --- | --- |
| `report` | 把摘要（+可选完整事件流）写成 Markdown 到 `outputTarget` 目录，文件名 `{date}-{scheduleName}.md`；同时在 artifacts 目录登记（复用后续 Artifacts 能力） |
| `notification` | 写 `notifications` 表 + WS 广播 `task.completed`，前端铃铛未读 +1 |
| `webhook` | HTTP POST JSON `{ scheduleId, name, status, summary, sessionId }` 到 `outputTarget`（P1，需 SSRF 防护：仅允许 https、禁止内网地址） |
| `none` | 不投递（仅留运行记录） |

**报告落地建议**：要求模型按固定模板输出（在 Prompt 里附 schema / 标题层级），否则每天的产物格式不一。

### 7.6 失败、重试与错过

- **失败**：`consecutiveFailures += 1`；达到阈值（如 5）自动 `enabled = false` 并发通知，避免每天静默失败烧钱。
- **重试**：P0 不做自动重试（下一周期自然重来）。P1 可对 `error` 类失败做 1 次指数退避重试。
- **错过**：见 §7.2 `catchUpPolicy`。
- **超时**：由 `TurnBudget.maxTurnDurationMs` 控制；schedule 级 `maxDurationMs` 覆盖全局值。

### 7.7 与 daemon 的关系

- P0：daemon 代码保留但**冻结**，不再新增能力；Web 已无入口。
- P1：在 README 标注 daemon 为 legacy，`yo bg` 保留给本地 CLI 用户。
- P2：评估删除 `packages/core/src/daemon`，或改造为「server 不可用时的本地兜底」。**不要**让定时功能依赖 daemon。

---

## 8. API 设计

### 8.1 HTTP（新增 `/api/v1/schedules`）

新增 `packages/server/src/routes/schedules.ts`，在 [app.ts](../packages/server/src/app.ts) 注册：`app.route('/api/v1/schedules', createScheduleRoutes({ storage, scheduler }))`。

RBAC：沿用现有模式（[rbac.ts](../packages/server/src/auth/rbac.ts)），新增权限 `schedules:read` / `schedules:write`。

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/v1/schedules` | 列表 | schedules:read |
| POST | `/api/v1/schedules` | 创建并计算 `nextRunAt` | schedules:write |
| GET | `/api/v1/schedules/:id` | 详情 | schedules:read |
| PUT | `/api/v1/schedules/:id` | 更新（cron/enabled 变更后重算 `nextRunAt`） | schedules:write |
| DELETE | `/api/v1/schedules/:id` | 删除（历史运行保留） | schedules:write |
| POST | `/api/v1/schedules/:id/run` | 立即运行一次（不影响 `nextRunAt`） | schedules:write |
| GET | `/api/v1/schedules/:id/runs` | 该任务的运行历史（`tasks` 表） | schedules:read |

**创建请求示例**

```json
POST /api/v1/schedules
{
  "name": "每日行业调研",
  "prompt": "调研 AI Agent 领域今日重要进展，按【要闻/融资/产品/论文】四节输出 Markdown 报告，每条附来源链接。",
  "cron": "0 9 * * *",
  "timezone": "Asia/Shanghai",
  "workspaceId": null,
  "model": null,
  "allowedTools": ["web_search", "web_fetch", "write_file", "read_file"],
  "outputKind": "report",
  "outputTarget": "reports/industry",
  "overlapPolicy": "skip",
  "catchUpPolicy": "skip"
}
```

**响应**

```json
{
  "schedule": {
    "id": "sch_...",
    "name": "每日行业调研",
    "nextRunAt": "2026-01-02T01:00:00.000Z",
    "enabled": true,
    "lastStatus": null
  }
}
```

> 注意：`0 9 * * *` + `Asia/Shanghai` 表示北京时间每天 09:00，对应 UTC 01:00。

**校验规则**

- `cron` 必须能被 cron-parser 解析，否则 400。
- `timezone` 必须是合法 IANA 时区。
- `outputKind = webhook` 时 `outputTarget` 必须是 https URL。
- `outputKind = report` 时 `outputTarget` 必须是相对工作区的安全路径（禁止 `..`）。

### 8.2 运行相关（沿用 `/api/v1/tasks`）

现有 [tasks.ts](../packages/server/src/routes/tasks.ts) 增加：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/tasks?scheduleId=xxx` | 按 schedule 过滤运行历史 |

### 8.3 WebSocket（新增通知）

在 [ws/protocol.ts](../packages/server/src/ws/protocol.ts) 的 `ServerMessage` 增加：

```ts
export interface TaskCompletedMessage {
  type: 'task.completed';
  scheduleId: string;
  runId: string;
  sessionId: string;
  name: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string | null;
}
```

前端在 `useWebSocket` 收到后：未读计数 +1、Toast 提示、刷新 schedule 列表。注意前端 [websocket.ts](../packages/web/src/api/websocket.ts) 的消息 switch 需要新增分支。

---

## 9. 前端设计

### 9.1 导航与路由

- [navigation.ts](../packages/web/src/config/navigation.ts)：在 `NAV_MODULES` 中 Chat 之后加
  ```ts
  { id: 'schedules', label: 'Schedules', path: '/schedules', icon: ClockIcon },
  ```
  需在 [Icons.tsx](../packages/web/src/components/Icons/Icons.tsx) 新增 `ClockIcon`（或复用现有图标）。
- [App.tsx](../packages/web/src/App.tsx)：新增 `<Route path="schedules" element={<SchedulesView />} />`。

### 9.2 页面与组件

新增：

```
features/schedules/SchedulesView.tsx      # 列表 + 空态 + 新建按钮
features/schedules/ScheduleForm.tsx       # 创建/编辑表单（含 cron 预设）
features/schedules/ScheduleRuns.tsx       # 运行历史（复用 tasks 数据）
components/Schedule/ScheduleCard.tsx      # 单条任务卡片：名称/cron 人类可读/下次时间/状态/开关
components/Notification/NotificationBell.tsx  # 顶部未读通知入口（P0 最小版）
```

**表单字段与控件**

| 字段 | 控件 | 默认 |
| --- | --- | --- |
| name | 文本 | — |
| prompt | 多行文本 + 示例模板 | — |
| 频率 | 单选：每天 / 每周 / 每月 / 自定义 | 每天 |
| 时间 | time 选择器 | 09:00 |
| 时区 | 下拉（默认浏览器时区） | Asia/Shanghai |
| 自定义 cron | 文本 + 实时校验 + 下次时间预览 | — |
| workspace | 下拉（工作区列表） | 无 |
| model | 下拉（`api.models`） | 默认 |
| 工具白名单 | 多选 | 调研模板预设 |
| 输出方式 | 下拉 report/notification | report |
| 输出目录/webhook | 文本 | reports/ |

**cron 人类可读**：前端用 `cronstrue` 之类展示「每天 09:00」，避免用户直接读 cron。

### 9.3 状态管理

新增 `stores/schedules.ts`（zustand，与现有 store 风格一致），提供 `load / create / update / remove / runNow`；`api/client.ts` 增加 `api.schedules` 命名空间。

### 9.4 与运行会话的关系

定时运行产生的会话 `type = 'background'`。两种处理，二选一（建议 A）：

- **A（推荐）**：会话照常出现在侧栏，标题前缀 `[定时]`，用户可点进去看完整过程与结果。侧栏可后续加过滤器隐藏。
- **B**：侧栏过滤 `type === 'background'`，只在运行历史里跳转。

---

## 10. 依赖与配置

- 新增依赖（server）：`cron-parser`（计算下次时间）。若不想加依赖，可实现最小 5/6 段解析，但不推荐。
- 新增依赖（web）：`cronstrue`（可选，人类可读）。
- 配置项（`ServerConfig`）：`schedulerEnabled`（默认 true）、`schedulerTickMs`（默认 30000）、`schedulerMaxConcurrent`（默认 3）、`schedulerDefaultCwd`。
- 环境变量：`YO_SCHEDULER=off` 可关闭调度器（便于测试/迁移）。

---

## 11. 分阶段实施计划

### P0 — 最小闭环（必须先跑通「结果有人看」）

1. 数据模型：`scheduled_tasks` + `notifications` 表、`tasks` 加两列、迁移、两个后端 Store、端口类型。
2. `SessionManager.sendMessage` 增加 `onSettled` 回调（§7.4.1）。
3. `scheduler/`：`cron.ts` + `scheduler.ts`（tick / 先写 nextRunAt / 内存并发守卫）+ `runner.ts`（`permissionMode: 'full'`、`type: 'background'`）。
4. `deliver.ts`：`report` 写文件 + `notification` 写表。
5. HTTP：`/api/v1/schedules` CRUD + `run` + `runs`；`/api/v1/tasks` 支持 `scheduleId` 过滤。
6. Web：`SchedulesView` + 表单 + 运行历史；导航与路由。
7. 启动/关闭接线（`index.ts`）+ `recover()` 僵尸清理。

**P0 验收标准**

- [ ] 创建一个「每天 09:00 Asia/Shanghai」的任务，`nextRunAt` 正确为次日对应 UTC 时间。
- [ ] 手动把 `nextRunAt` 改到 1 分钟后，不重启服务，能自动触发一次无头运行且**无审批弹窗**。
- [ ] 运行结束后 `tasks` 行状态为 completed，`summary` 非空，`scheduled_tasks.lastRunAt/lastStatus` 更新，`nextRunAt` 顺延。
- [ ] 目标目录生成一份 Markdown 报告；站内出现一条未读通知。
- [ ] 运行期间打开该 background 会话，能看到实时事件流与最终结果。
- [ ] 关闭/重启 server：重启后不重复触发已运行的周期；`running` 僵尸运行被置为 failed。
- [ ] 运行中再次到点 → 按 `skip` 不并发执行。
- [ ] 停用（enabled=false）后不再触发。
- [ ] 删除任务后不再触发，历史运行仍可查询。

### P1 — 可用性

- cron 人类可读、下次运行预览、"立即运行"。
- `allowedTools` 白名单生效。
- 连续失败自动停用 + 通知；`webhook` 投递（含 SSRF 防护）。
- 运行历史分页、失败详情、跳转会话。
- 侧栏 background 会话过滤/分组。

### P2 — 健壮性与多实例

- 分布式租约锁（DB 行锁 / `nextRunAt` 原子抢占），支持多实例部署。
- `overlapPolicy = queue` 持久队列。
- 多租户：给 `scheduled_tasks`/`tasks`/`sessions` 补 `tenantId` 并强制隔离（见 §13）。
- 删除或改造 daemon。

---

## 12. 测试计划

**单元测试**

- `cron.ts`：给定 cron + 时区，`next()` 结果正确（含 DST 边界、跨天/跨月）。
- `scheduler.tick`：到期的进入 dispatch、未到期的不进；并发上限生效；dispatch 前 `nextRunAt` 已写回。
- overlap `skip`/`allow`；catchUp `skip`/`run_once`/`grace`。
- `deliver`：report 路径安全（拒绝 `..`）；webhook URL 校验。

**集成测试**

- 建 schedule → 改 `nextRunAt` 为过去 → 触发 → 断言 `tasks`/`sessions`/`notifications` 行与状态流转。
- server 重启恢复：僵尸 running 清理、不重复触发。
- `sendMessage` 的 `onSettled` 在 done/error/interrupted 三种情况下都被调用。

**手工验收**

- 用 `FakeLLMClient`（`YO_PROVIDER=fake`）跑通全链路，避免真实 token 消耗。

---

## 13. 风险与开放问题

| # | 问题 | 影响 | 建议 |
| --- | --- | --- | --- |
| 1 | 无人审批 + `full` 权限意味着能跑 shell/写文件/联网 | 安全 | P0 用沙箱 + 预算；P1 强制工具白名单；默认模板只给 web_search/web_fetch/write_file |
| 2 | 结果无人查看 | 产品价值 | 报告 + 通知是 P0 必做；后续可加邮件/IM |
| 3 | server 停机错过触发 / 多实例重复触发 | 正确性 | catchUpPolicy + P2 分布式锁 |
| 4 | 每次运行烧 token | 成本 | schedule 级预算 + 全局并发上限 + 连续失败停用 |
| 5 | sessions/tasks/memories 当前均无 `tenantId` | 多租户隔离 | 若要多租户，需一次性给相关表补租户列并加过滤，属独立工作项 |
| 6 | 调研类输出质量波动 | 可信度 | 固定报告模板 / schema；可加「输出校验失败重试」 |
| 7 | 时区与 DST | 正确性 | 用 IANA 时区 + cron-parser，测试覆盖 DST |
| 8 | 长期无人值守运行可能累积大量会话 | 噪音 | background 会话过滤/归档策略（P1） |

---

## 14. 附录：关键代码落点

| 文件 | 改动 |
| --- | --- |
| `packages/core/src/core/ports.ts` | 新增 `ScheduledTask` / `ScheduledTaskStore` 类型 |
| `packages/server/src/storage/schema.ts` | 新增 `scheduled_tasks` / `notifications` 表，`tasks` 加列 |
| `packages/server/src/storage/migrate.ts` | 迁移 |
| `packages/server/src/storage/sqlite.ts` | `SqliteScheduledTaskStore`、备份 store |
| `packages/server/src/storage/postgres.ts` | `PostgresScheduledTaskStore` |
| `packages/server/src/storage/interface.ts` | `scheduledTasks` / `notifications` 挂到 `StorageBackend` |
| `packages/server/src/session-manager.ts` | `sendMessage` 增加 `onSettled` |
| `packages/server/src/scheduler/*` | 新增调度器、runner、cron、deliver |
| `packages/server/src/routes/schedules.ts` | 新增路由 |
| `packages/server/src/routes/tasks.ts` | `scheduleId` 过滤 |
| `packages/server/src/ws/protocol.ts` | `task.completed` 消息 |
| `packages/server/src/app.ts` | 注册路由、AppDeps 增加 `scheduler` |
| `packages/server/src/index.ts` | 创建、启动、关闭 scheduler |
| `packages/web/src/config/navigation.ts` | Schedules 导航项 |
| `packages/web/src/App.tsx` | `/schedules` 路由 |
| `packages/web/src/api/client.ts` | `api.schedules` |
| `packages/web/src/stores/schedules.ts` | 新增 store |
| `packages/web/src/features/schedules/*` | 列表 / 表单 / 运行历史 |
| `packages/web/src/api/websocket.ts` | 处理 `task.completed` |
