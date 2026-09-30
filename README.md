# yo-harness

本地优先的个人智能体平台（local-first personal agent harness）。CLI 驱动，事件溯源，支持多轮对话、工具调用、审批交互、会话恢复。

## 特性

- **交互式 CLI**：基于 ink + React 的终端 UI，流式输出，实时状态显示
- **Web UI**：React SPA，提供会话管理、实时对话、审批交互、记忆管理等功能
- **Headless Server**：HTTP + WebSocket 服务，基于 Hono 框架，支持 SQLite 和 PostgreSQL
- **双 Provider 支持**：Anthropic + OpenAI 兼容（DeepSeek / 豆包 Ark / Kimi / OpenRouter 等）
- **6 个内置工具**：`read_file`、`write_file`、`list_dir`、`shell`、`web_fetch`、`web_search`
- **审批系统**：写操作和危险命令需用户确认，支持"本次放行"和"会话内始终允许"
- **事件溯源**：全部动作以事件流落库（SQLite），进程重启后可恢复会话
- **上下文管理**：自动估算 token、分级裁剪，长对话不超窗
- **安全约束**：密钥只从环境变量读取，文件操作限制在工作目录内，SSRF 防护
- **规划器**：复杂任务先只读探索代码库，产出结构化执行计划，用户确认后按计划推进
- **检查点与撤销**：写操作前自动快照，支持 `/undo` 回滚文件变更
- **目标追踪**：长任务漂移检测，定期提醒当前目标，防止上下文丢失
- **MCP 工具集成**：通过 Model Context Protocol 接入外部工具服务器，自动发现并注册
- **语义记忆**：自动提取用户偏好与事实，FTS5 全文搜索，跨会话持久化
- **多模型路由**：不同角色（主对话 / 摘要 / 嵌入）可配置不同模型
- **后台任务**：daemon 进程管理长时间任务，CLI 提交 / 查询 / 取消
- **会话管理**：自动命名（默认取首问前几个字），支持自定义改名 / 置顶 / 归档 / 删除
- **工作区**：多会话分组管理，会话可绑定 / 解绑工作区，删除工作区不丢会话
- **多租户**：Server 支持多租户隔离，每个租户独立数据空间

## 安装

```bash
# 克隆仓库
git clone <repo-url>
cd yo-harness

# 安装依赖
npm install

# 复制环境变量样例并填写 API key
cp .env.example .env
# 编辑 .env，至少填写一个 Provider 的 API key
```

## 快速上手

### 启动交互式会话

```bash
# 使用默认 Provider（Anthropic）
npm run dev

# 指定 Provider
npm run dev -- --provider openai-compat

# 使用离线脚本化 Provider（无需 API key，用于冒烟测试）
npm run dev -- --fake

# 指定模型
npm run dev -- -m claude-sonnet-4-5
```

### 非交互模式

```bash
# 发送一条消息，打印回复后退出
npm run dev -- -p "hello, what can you do?"
npm run dev -- --fake -p "hello"  # 离线模式

# 规划模式：先探索再产出执行计划（不执行）
npm run dev -- --plan "重构认证模块，从 session 迁移到 JWT"
```

### 恢复历史会话

```bash
# 弹出选择器，选择最近 10 个会话
npm run dev -- resume

# 直接恢复指定会话（完整 UUID 或前 8 字符前缀）
npm run dev -- resume <session-id>

# 恢复并继续对话（非交互）
npm run dev -- resume <session-id> --fake -p "continue from where we left off"
```

### 内置命令（交互模式下）

- `/help` — 显示帮助
- `/exit` — 退出（等待当前 turn 结束）
- `/model` — 显示当前 Provider / 模型
- `/sessions` — 列出最近 10 个会话
- `/plan <描述>` — 规划模式：先只读探索代码库，产出结构化执行计划
- `/undo` — 撤销上一次文件变更（回滚到上一个检查点）
- `/checkpoints` — 列出当前会话的检查点历史
- `/goal` — 显示/设置当前目标（长任务漂移检测）

## 配置

### 环境变量（.env）

参见 `.env.example`，主要包括：

- `ANTHROPIC_API_KEY` — Anthropic API key
- `OPENAI_COMPAT_API_KEY` — OpenAI 兼容 Provider API key
- `TAVILY_API_KEY` / `BOCHA_API_KEY` / `SERPER_API_KEY` — 网络搜索 API key（三选一）
- `YO_PROVIDER` — 覆盖默认 Provider
- `YO_MODEL` — 覆盖默认模型
- `YO_BASE_URL` — OpenAI 兼容 Provider 的自定义端点
- `YO_SECRET_KEY` — 加密 Web UI 中保存的 API 密钥（缺省自动生成 `~/.yo-harness/secret.key`）
- `YO_LOG` — 日志级别（debug / info / warn / error）

### Web UI 模型配置（推荐）

在 Web UI 的「设置 → 模型」中可以直接管理 Provider：填写显示名称、API 地址、API 协议与 API 密钥，并通过「获取可用模型」调用 Provider 的模型列表接口自动填充模型目录；保存后持久化到服务端存储（SQLite / PostgreSQL），点击「保存」即可切换当前使用的模型，**无需修改 `.env` 或重启服务**。

优先级：**Web UI 配置 > `.env` / 进程环境 > config.json > 内置默认**。

- 未做任何 Web UI 配置时，行为与只用 `.env` 完全一致；
- Web UI 配置不完整（例如密钥被删）时自动回退到 `.env`，界面会给出提示；
- 密钥通过 AES-256-GCM 加密存储，且**永不回传前端**（列表只显示掩码）；
- 配置变更后，新建会话立即使用新模型；正在执行的 turn 不被打断，空闲会话会在下一条消息时重建。

详见 [docs/MODEL-CONFIG-DESIGN.md](docs/MODEL-CONFIG-DESIGN.md)。

### 配置文件（~/.yo-harness/config.json）

可选，用于精细控制 Provider 参数、权限、预算等：

```json
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "model": "claude-sonnet-4-5",
      "contextWindow": 200000
    },
    "openai-compat": {
      "apiKeyEnv": "OPENAI_COMPAT_API_KEY",
      "model": "deepseek-chat",
      "contextWindow": 128000,
      "baseURL": "https://api.deepseek.com"
    }
  },
  "modelRoles": {
    "summarize": { "provider": "anthropic", "model": "claude-haiku-3-5" }
  },
  "search": {
    "provider": "tavily",
    "apiKeyEnv": "TAVILY_API_KEY"
  },
  "mcp": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  },
  "permission": {
    "shellMode": "ask",
    "shellAllowlist": ["ls", "cat", "grep"]
  },
  "budget": {
    "maxStepsPerTurn": 20,
    "maxTokensPerTurn": 100000,
    "maxTurnDurationMs": 300000
  },
  "checkpointing": {
    "enabled": true
  },
  "planner": {
    "maxExploreSteps": 10
  },
  "goalTracking": {
    "driftThreshold": 8
  },
  "daemon": {
    "idleTimeoutMs": 300000
  }
}
```

## 工具说明

| 工具 | 功能 | 风险级别 | 审批策略 |
|---|---|---|---|
| `read_file` | 读取文件内容 | read | 自动放行 |
| `write_file` | 写入文件（限制在工作目录内） | write | 需审批 |
| `list_dir` | 列出目录内容 | read | 自动放行 |
| `shell` | 执行 shell 命令 | danger | 按 `shellMode` 配置 |
| `web_fetch` | 抓取网页内容（SSRF 防护） | net | 自动放行 |
| `web_search` | 网络搜索（需配置搜索 API） | net | 自动放行 |

### Shell 命令审批模式

- `ask`（默认）：每条命令都需审批
- `allowlist`：白名单内的命令自动放行，其余需审批
- `yolo`：全部放行（危险，仅限可信沙箱）

## 开发

```bash
# 类型检查
npm run typecheck

# ESLint
npm run lint

# 单元测试
npm test

# 全部检查（typecheck + lint + test）
npm run check
```

### 项目结构

```
yo-harness/                       # pnpm monorepo
├── packages/
│   ├── core/                     # 共享内核（AgentLoop、ContextManager、EventBus、
│   │                             #   Permission、Compressor、Summarizer、Planner、
│   │                             #   GoalTracker、Checkpoint、LLM Gateway、Tools、
│   │                             #   MCP、Memory、Router、Sandbox）
│   ├── cli/                      # 交互式 CLI（ink + React TUI）
│   ├── server/                   # Headless HTTP + WebSocket 服务端（Hono）
│   │   ├── src/auth/             #   JWT + Argon2 鉴权
│   │   ├── src/routes/           #   REST API 路由
│   │   ├── src/ws/               #   WebSocket Hub + 协议
│   │   ├── src/sandbox/          #   沙箱管理（Local / Docker / Pool）
│   │   ├── src/storage/          #   存储后端（SQLite / PostgreSQL）
│   │   └── src/tenant/           #   多租户隔离
│   └── web/                      # React SPA（Vite + Zustand）
│       ├── src/api/              #   HTTP + WebSocket 客户端
│       ├── src/components/       #   UI 组件（Chat、Sidebar、Approval、Plan、Memory…）
│       ├── src/hooks/            #   React hooks
│       ├── src/pages/            #   页面（Login、Register）
│       ├── src/stores/           #   Zustand 状态管理
│       └── tests/                #   组件测试
├── docker/
│   ├── Dockerfile.server         # Server 镜像（Node 20 + tsx）
│   ├── Dockerfile.web            # Web 镜像（Nginx + 静态文件）
│   ├── docker-compose.yml        # 生产部署（server + web + PostgreSQL）
│   ├── docker-compose.dev.yml    # 开发环境（热重载 + SQLite）
│   ├── docker-compose.sandbox.yml # Docker 沙箱模式
│   └── sandbox/                  # 沙箱基础镜像
└── examples/                     # 手动冒烟脚本
```

### 架构要点

- **事件溯源**：全部动作以事件流落库，会话恢复 = 事件重放
- **端口-适配器**：内核（core/）只依赖端口（ports.ts），存储 / LLM / 工具提供实现
- **纯函数渲染**：RenderModel 把事件折叠为 RenderLine，不依赖 ink / React
- **密钥纪律**：API key 只从环境读取，不进配置对象、不落库、不进事件流

### 核心能力

**规划器（Planner）**
复杂任务直接丢给 ReAct 循环容易目标漂移。规划器让模型先用只读工具探索代码库，产出结构化计划（JSON），用户确认后交给执行者按计划推进。规划阶段只能用只读工具（`read_file`、`list_dir`），确保不会意外修改代码。

**检查点与撤销（Checkpoint & Undo）**
写操作前自动快照文件内容到 SQLite，支持 `/undo` 回滚到上一个检查点。检查点来源分三种：`auto_write`（write_file 前自动）、`auto_undo`（undo 操作前）、`manual`（手动触发）。

**目标追踪（Goal Tracker）**
长任务容易上下文丢失、目标漂移。设置目标后，每 N 步（默认 8 步）提醒模型当前目标，检测是否偏离方向。可通过 `/goal` 命令设置或查看当前目标。

**工具错误恢复**
工具调用失败时，根据错误类型分类处理：瞬态错误（网络超时、限流）自动重试最多 3 次；永久错误（权限拒绝、文件不存在）立即返回不重试；未知错误按瞬态处理。

**自适应压缩**
上下文接近窗口限制时，自动压缩旧消息：保留最近 N 条完整消息，更早的用 LLM 生成摘要替换。压缩策略分两种：`tool_results`（只压缩工具返回结果）、`turns`（压缩整个 turn）。

**MCP 工具集成**
通过 [Model Context Protocol](https://modelcontextprotocol.io) 接入外部工具服务器。在 `~/.yo-harness/config.json` 的 `mcp` 字段配置服务器列表，启动时自动发现并注册工具。工具名格式为 `{serverName}__{toolName}`（双下划线分隔）。参见 `mcp.json.example`。

**语义记忆**
自动从对话中提取用户偏好与事实（`MemoryExtractor`），存入 SQLite + FTS5 全文索引。新会话开始时，`MemoryInjector` 根据当前上下文搜索相关记忆注入 system prompt。支持 `/memory` 命令手动管理。

**多模型路由**
不同角色可配置不同模型：主对话用大模型（如 Claude Sonnet），摘要/压缩用小模型（如 Claude Haiku），降低成本。在 `config.json` 的 `modelRoles` 字段配置角色映射。`CostTracker` 实时追踪各模型 token 用量。

**后台任务**
长时间运行的任务可提交到后台 daemon 进程执行，不阻塞当前会话：
```bash
# 提交后台任务
yo bg "分析这个代码库的架构并生成报告"

# 查看任务列表
yo tasks

# 查看任务详情
yo task <task-id>

# 取消任务
yo task-cancel <task-id>

# 手动启动/停止 daemon
yo daemon
yo daemon-stop
```
daemon 监听 Unix socket（`~/.yo-harness/daemon.sock`），空闲 5 分钟自动退出。

### Server & Web UI

**Headless Server**
`packages/server` 提供 HTTP + WebSocket 服务，基于 Hono 框架。支持 SQLite（开发/单机）和 PostgreSQL（生产）两种存储后端。

```bash
# 启动服务端（SQLite，默认端口 3456）
pnpm --filter @yo-harness/server run dev

# 指定 PostgreSQL
YO_STORAGE=postgres YO_PG_HOST=localhost pnpm --filter @yo-harness/server run dev
```

**Web UI**
`packages/web` 是 React SPA，提供会话管理、实时对话、审批交互、记忆管理等功能。

```bash
# 启动 Web 开发服务器（默认端口 5173，自动代理到 server 3456）
pnpm --filter @yo-harness/web run dev
```

**CLI 远程模式**
CLI 可连接远端 server 而非直接操作本地存储：

```bash
# 连接远端 server
yo --server http://localhost:3456

# 带认证
yo --server https://yo.example.com --token <jwt-token>
```

## Docker 部署

### 生产环境（PostgreSQL）

```bash
cd docker
# 设置 JWT 密钥（生产环境务必修改）
export YO_JWT_SECRET=your-production-secret

# 可选：配置 LLM provider
export YO_PROVIDER=anthropic
export YO_MODEL=claude-sonnet-4-5
export YO_API_KEY=sk-xxx

docker compose up -d
```

服务启动后：
- Web UI：http://localhost:8080
- API Server：http://localhost:3456

### 开发环境（SQLite，热重载）

```bash
cd docker
docker compose -f docker-compose.dev.yml up -d
```

### Docker 沙箱模式

启用 Docker-in-Docker 工具执行隔离：

```bash
cd docker
export YO_JWT_SECRET=your-secret
docker compose -f docker-compose.sandbox.yml up -d
```

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `YO_JWT_SECRET` | JWT 签名密钥 | `change-me-in-production` |
| `YO_PORT` | 服务端口 | `3456` |
| `YO_STORAGE` | 存储后端（`sqlite` / `postgres`） | `sqlite` |
| `YO_PG_*` | PostgreSQL 连接参数 | — |
| `YO_PROVIDER` | LLM Provider | `fake` |
| `YO_MODEL` | LLM 模型名 | `fake` |
| `YO_API_KEY` | LLM API Key | — |
| `YO_BASE_URL` | 自定义 API base URL | — |
| `YO_SANDBOX_MODE` | 沙箱模式（`local` / `docker`） | `local` |

## 示例脚本

```bash
# 真实 API 调用冒烟测试（需配置 API key）
npx tsx examples/ping.ts anthropic
npx tsx examples/ping.ts openai

# 事件完整性校验
npx tsx examples/replay-check.ts                  # 列最近会话
npx tsx examples/replay-check.ts <session-id>     # 校验指定会话
```

## FAQ

**Q: 支持哪些模型？**

A: Anthropic（Claude 系列）和任何 OpenAI 兼容 API（DeepSeek、豆包 Ark、Kimi、OpenRouter 等）。通过 `--provider` 或配置文件切换。

**Q: 没有 API key 能试用吗？**

A: 可以。使用 `--fake` 参数启动离线脚本化模式，无需 API key 即可体验完整流程。

**Q: 会话数据存储在哪里？**

A: `~/.yo-harness/sessions.db`（SQLite，WAL 模式）。可通过 `YO_DATA_DIR` 环境变量覆盖。

**Q: 如何中断正在执行的 turn？**

A: 按 `Ctrl+C` 一次请求中断（等待当前工具结束），再按一次强制退出。

**Q: 写操作安全吗？**

A: 所有写操作（`write_file`、`shell`）默认需用户审批。文件操作限制在工作目录内，shell 命令可按白名单控制。

**Q: 支持多轮对话吗？**

A: 支持。交互模式下可持续对话，上下文自动管理（token 超预算时分级裁剪）。

**Q: 如何恢复之前的会话？**

A: 退出后运行 `yo resume` 弹出选择器，或 `yo resume <id>` 直接恢复。

## License

MIT
