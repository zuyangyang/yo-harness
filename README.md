# yo-harness

本地优先的个人智能体平台（local-first personal agent harness）。CLI 驱动，事件溯源，支持多轮对话、工具调用、审批交互、会话恢复。

## 特性

- **交互式 CLI**：基于 ink + React 的终端 UI，流式输出，实时状态显示
- **双 Provider 支持**：Anthropic + OpenAI 兼容（DeepSeek / 豆包 Ark / Kimi / OpenRouter 等）
- **6 个内置工具**：`read_file`、`write_file`、`list_dir`、`shell`、`web_fetch`、`web_search`
- **审批系统**：写操作和危险命令需用户确认，支持"本次放行"和"会话内始终允许"
- **事件溯源**：全部动作以事件流落库（SQLite），进程重启后可恢复会话
- **上下文管理**：自动估算 token、分级裁剪，长对话不超窗
- **安全约束**：密钥只从环境变量读取，文件操作限制在工作目录内，SSRF 防护

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

## 配置

### 环境变量（.env）

参见 `.env.example`，主要包括：

- `ANTHROPIC_API_KEY` — Anthropic API key
- `OPENAI_COMPAT_API_KEY` — OpenAI 兼容 Provider API key
- `TAVILY_API_KEY` / `BOCHA_API_KEY` / `SERPER_API_KEY` — 网络搜索 API key（三选一）
- `YO_PROVIDER` — 覆盖默认 Provider
- `YO_MODEL` — 覆盖默认模型
- `YO_LOG` — 日志级别（debug / info / warn / error）

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
  "search": {
    "provider": "tavily",
    "apiKeyEnv": "TAVILY_API_KEY"
  },
  "permission": {
    "shellMode": "ask",
    "shellAllowlist": ["ls", "cat", "grep"]
  },
  "budget": {
    "maxStepsPerTurn": 20,
    "maxTokensPerTurn": 100000,
    "maxTurnDurationMs": 300000
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
src/
├── cli/           # TUI 层（ink App、renderer、picker、approval）
├── config/        # 配置加载与校验
├── core/          # 内核（AgentLoop、ContextManager、EventBus、Permission）
├── llm/           # LLM 网关与 Provider 适配
├── storage/       # SQLite 存储（SessionStore、EventStore）
├── tools/         # 工具注册表与 6 个内置工具
├── types/         # 领域类型与 zod schema
└── utils/         # 工具函数（logger、tokens、paths）
tests/             # 单元测试（与 src/ 同构）
examples/          # 手动冒烟脚本（不进 CI）
```

### 架构要点

- **事件溯源**：全部动作以事件流落库，会话恢复 = 事件重放
- **端口-适配器**：内核（core/）只依赖端口（ports.ts），存储 / LLM / 工具提供实现
- **纯函数渲染**：RenderModel 把事件折叠为 RenderLine，不依赖 ink / React
- **密钥纪律**：API key 只从环境读取，不进配置对象、不落库、不进事件流

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
