# yo-harness Web UI 整体设计文档

> 版本 v1.0 · 2026-09-30 · 状态：待评审
> 范围：yo-harness Web 前端（packages/web）的整体信息架构、布局、组件规范、设计系统与功能缺口占位策略
> 关联文档：docs/CHAT-DISPLAY-REDESIGN.md（对话区 Turn 化方案，已部分落地）

## 目录

1. 背景与现状盘点
2. 目标与非目标
3. 竞品参考与模式取舍
4. 信息架构（IA）
5. 布局方案
6. 组件规范
7. 功能缺口与「开发中」占位策略
8. 设计系统（Design Tokens）
9. 事件到 UI 的完整映射
10. 前端架构调整
11. 实施路线图
12. 文件变更清单
13. 验收与测试策略
14. 风险与开放问题
- 附录 A：图标清单
- 附录 B：Token 全表
- 附录 C：参考链接

---

## 0. 文档目的

当前 yo-harness Web UI 只完成了「能跑通」的最小形态：一个侧边会话列表、一条顶部 Tab、一个对话区、一条底部状态栏。它没有承载 yo-harness 已经具备的大部分能力（计划、检查点、记忆、后台任务、审批、MCP、成本），也没有成熟 Agent Harness 应有的工作台结构。

本文档要解决三件事：

1. **定结构** —— 给出可长期演进的整体布局（App Shell）与信息架构，明确每个区域的职责、尺寸与响应式行为。
2. **定规范** —— 给出设计系统（色彩 / 字体 / 间距 / 圆角 / 动效 / 图标 / 组件状态）与逐组件的实现规格，后续开发只按本规范落地，不再临时发挥。
3. **定边界** —— 对「必要但当前缺失」的功能，统一约定入口、图标、文案与点击行为（显示「开发中」），既让界面完整、可演示，又不制造假功能。

本文档只覆盖前端；凡需要后端配合的项（如 LLM 流式 delta、diff 引擎、终端、文件树），均在文中显式标注为「依赖后端」并给出降级方案。

---

## 1. 背景与现状盘点

### 1.1 现状

登录后进入单页工作台：左侧 260px 会话列表，顶部 48px 条（Logo + Chat/Memory/Tasks 三个 Tab + 主题切换），中间内容区，底部一条状态栏（Connected / Steps / Tokens / Events）。对话空态只有一句话「Start a conversation by sending a message」。

对话区在 docs/CHAT-DISPLAY-REDESIGN.md 之后已经做了 Turn 化：**TurnBlock / ThinkingSection / ToolSteps / turn-grouping 均已在代码中存在并被 ChatArea 使用**。因此本次重设计的主战场是「全局骨架 + 周边面板 + 设计系统 + 功能缺口」，而不是重新发明对话区。

### 1.2 现有组件与文件

| 区域 | 文件 | 现状 |
| --- | --- | --- |
| 根 | src/App.tsx | BrowserRouter，仅 /login /register /*，无业务子路由 |
| 布局 | src/components/MainLayout.tsx | activeTab 为组件内 state；sidebarOpen 定义了但从不切换 |
| 顶栏 | src/components/TopBar/TopBar.tsx | Logo + 3 Tab + 主题按钮 |
| 侧栏 | src/components/Sidebar/Sidebar.tsx | New Session + 会话列表 + 用户/设置/登出 |
| 会话项 | src/components/Sidebar/SessionItem.tsx | 图标 + 标题 + model·date + 删除 |
| 对话 | src/components/Chat/ChatArea.tsx | 标题 + Turn 列表 + 输入表单 |
| 对话 | Chat/TurnBlock.tsx、ThinkingSection.tsx、ToolSteps.tsx、utils/turn-grouping.ts | 已实现 Turn 分组与折叠 |
| 对话 | Chat/MessageBubble.tsx、ToolCallCard.tsx | Turn 化后已不在主路径（遗留） |
| 记忆 | components/Memory/MemoryManager.tsx | 搜索 + 分类 + 表单 + 列表（功能完整但样式朴素） |
| 任务 | components/Task/TaskList.tsx | 表格 + 刷新 + 取消 |
| 计划 | components/Plan/PlanView.tsx | 组件存在，但**全项目无任何引用，是死代码** |
| 模型 | components/Model/ModelSelector.tsx | 一个原生 select |
| 审批 | components/Approval/ApprovalDialog.tsx | 模态遮罩，与工具步骤无视觉关联 |
| 状态栏 | components/StatusBar/StatusBar.tsx | 连接 / Steps / Tokens / Events |
| 图标 | components/Icons/Icons.tsx | 18 个内联 SVG（Heroicons 风格，24 viewBox） |
| 样式 | src/styles.css | 1761 行单文件，含全部与组件样式 |
| 状态 | stores/{session,auth,approval}.ts | Zustand；错误多处 catch {} 静默吞掉 |

### 1.3 现状问题清单

**P0（结构性问题，直接导致「简陋」）**

1. **没有一级导航常驻栏**。模块切换依赖 TopBar 里三个文字 Tab，模块一多就无处安放，且没有图标、没有层级、没有当前态强调。
2. **视图状态没有 URL**。activeTab 是 MainLayout 的 useState，刷新即回到 Chat；无法深链到某个会话、任务或记忆，浏览器前进/后退失效。
3. **对话区没有阅读宽度约束**。ChatArea 铺满整个内容区，在 1920 宽的屏幕上正文行长过长（现状截图即一行横跨全屏），可读性差。
4. **右侧没有上下文面板**。PlanView 已实现却无处渲染；checkpoint、context 压缩/裁剪、memory 注入、goal 提醒这些事件全部被丢弃，用户在界面上看不到 Agent 的「工作现场」。
5. **侧边栏无法折叠/展开**。sidebarOpen 恒为 false，配套的 .sidebar-toggle 样式的 DOM 从未出现；移动端没有任何抽屉入口。

**P1（体验与信息完整性问题）**

6. 输入区「+」按钮无任何行为；占位文案承诺的「/ 指令」「@ 文件或对话」均未实现，承诺与能力不一致。
7. 会话列表无搜索、无按时间分组、无重命名/置顶/归档，信息只有 model·date。
8. 设计 token 层级不足：surface 只有一组无明确海拔语义的色值，缺 diff / 终端 / 代码块专用色；正文字号 13px 偏小；空态仅一行文字。
9. 状态反馈缺失：无 Toast、无 loading skeleton、错误被 catch {} 静默吞掉，用户不知道发生了什么。
10. 图标系统不足：缺搜索、面板、终端、文件、分支、复制、重试、停止、附件、命令面板等常用图标。
11. 状态栏信息偏弱：没有当前模型、上下文占用、成本、快捷键入口。

**P2（工程与可访问性）**

12. 可访问性：SessionItem、turn-thinking__summary、turn-tools__summary 等可点击 div 无 role/tabIndex/键盘事件；无统一 focus-visible；无 aria-live 播报流式状态。
13. 工程：styles.css 单文件 1761 行；测试仅 4 个文件，新组件缺少测试基线。

### 1.4 后端已就绪、但 Web 未呈现的能力

| 能力 | 后端入口 | 现状 |
| --- | --- | --- |
| 会话 CRUD / 消息 / 中断 / 事件回放 | /api/v1/sessions 系列 | 已用部分（list/get/create/delete/messages/events/interrupt） |
| 审批 | WS approval.request + /api/v1/approvals/:id/resolve | 已用 |
| 记忆 | /api/v1/memories（list/search/create/update/delete） | Memory 页已用 |
| 后台任务 | /api/v1/tasks（list/get/cancel） | Task 页已用 |
| 模型与角色 | /api/v1/models（models + roles） | 仅用 models，roles 未用 |
| 计划 | 事件 plan_created / plan_approved / plan_rejected / plan_task_updated | 事件未消费 |
| 检查点 / 撤销 | 事件 checkpoint_created / checkpoint_restored（CLI /undo /checkpoints） | 事件未消费 |
| 目标 | 事件 goal_reminder（CLI /goal） | 事件未消费 |
| 上下文压缩 | 事件 context_compressed / context_elided | 事件未消费 |
| 记忆流转 | 事件 memory_extracted / memory_injected | 事件未消费 |
| MCP | core/mcp | Web 完全没有入口 |
| 管理端 | /admin/tenants、/admin/whoami | Web 完全没入口 |

### 1.5 设计约束（必须遵守）

- **ESM + NodeNext**：所有相对导入必须带 .js 后缀（现有代码统一如此）。
- **不引入重型 UI 框架**：继续 React 18 + 手写 CSS 变量；可选引入极小的无样式库（如 floating-ui）仅在有明确需求时。
- **不破坏已实现的对话区**：TurnBlock 等作为基线，增量增强而非重写。
- **事件 schema 没有 llm_delta**：真正的逐字流式需要后端扩展事件类型，本期不做，列入开放问题。
- **保持主题机制**：沿用 data-theme="light|dark" + localStorage 键 yo-theme。

---

## 2. 目标与非目标

### 2.1 设计目标

1. **工作台化**：把「一个页面」升级为「一个有导航、有会话、有主舞台、有上下文侧栏的工作台」。
2. **渐进披露**：默认只展示结论与摘要（Turn 折叠、工具步骤折叠、面板可收起），需要时再展开细节。
3. **一致的设计语言**：建立语义化 token 与统一组件（Button/IconButton/Tabs/Tooltip/Toast/EmptyState/Skeleton/Menu），消除各处手写样式。
4. **信息完整**：把 22 种事件按重要性分级呈现，低优先级事件收拢为时间线旁的元信息 chip，不丢失也不喧宾夺主。
5. **可演示的完整性**：缺失功能有图标、有 label、有明确点击反馈（Toast「开发中」），界面看起来是完整的，而不是残缺的。
6. **可访问、可响应**：键盘可达、焦点可见、屏幕阅读器可播报；1280–1920 为主战场，1024/768 可用。

### 2.2 可验收的量化目标

- 三个主视口（1440 / 1920 / 1024）下无横向滚动、无遮挡、无布局抖动。
- 所有一级模块可通过 URL 直达并在刷新后保持；浏览器前进后退可用。
- 所有可点击元素可用 Tab 聚焦、Enter/Space 触发，focus-visible 可见。
- 缺口功能 100% 通过统一 ComingSoon 通道反馈，无「点了没反应」的元素。
- 组件单测覆盖新增 UI 基础组件与 Turn 分组逻辑（沿用 vitest + @testing-library/react）。

### 2.3 非目标（本期不做）

- 不实现真实终端、文件树、Git diff 引擎、浏览器预览。
- 不实现 LLM 逐字流式（依赖后端 llm_delta 事件）。
- 不引入 Tailwind / shadcn / Radix 等整套框架（保持手写 CSS，降低迁移成本）。
- 不做多语言 i18n（文案暂以中英混排现状为准，本期只收敛术语，见 §8.7）。
- 不改动后端接口（如确需新增，单独提接口约定，不在本文范围）。

---

## 3. 竞品参考与模式取舍

Agent Harness 的 Web UI 在过去两年收敛出了相当一致的形态。下表是本次设计的直接参考与取舍。

| 产品 | 标志性模式 | 我们采用 | 我们不采用 |
| --- | --- | --- | --- |
| Claude Code / Claude Desktop | 会话列表 + 对话流；思考（Thinking）折叠；工具调用成组折叠；变更审查视图 | 左侧会话列表、Turn 内 Thinking 折叠、工具步骤分组折叠、右侧审查面板 | 纯终端形态；本期不做逐字打字机流式（缺后端事件） |
| Cursor | 左侧文件/会话、中央编辑与对话、右侧 Agent 面板；工具步骤时间线；inline diff 的 Accept/Reject | 三区可折叠布局；工具步骤的 diff 预览位；右侧上下文面板 | 代码编辑器本身（yo-harness 不做 IDE） |
| OpenHands | 左侧会话列表；中央对话；右侧工作区多 Tab（Changes / Terminal / Browser / Files） | 右侧 ContextPanel 多 Tab（Plan / Files / Diff / Terminal / Memory） | Browser/截图沙箱（依赖后端，列为占位） |
| ChatGPT / Codex | 会话历史 + 搜索 + 分组；Composer 常驻底部；附件与工具入口；任务/Canvas 侧栏 | 会话搜索与按时间分组；底部 Composer（附件/指令/模型）；Tasks 侧栏 | 移动优先的极简气泡 |
| Windsurf Cascade | 步骤时间线（step timeline）；每一步可展开查看输入输出 | 工具步骤的「名称 + 参数摘要 + 状态 + 耗时」行，展开看全文 | 与 IDE 深度绑定的布局 |
| Devin | 会话即工作区：计划/进度在顶部，终端与编辑器分屏，结果贴回对话 | 顶部 Goal/Plan 进度条；右侧面板；后台任务集中管理 | 云端 VM 的复杂多窗格 |

**六条被反复验证的规律（本设计的立足点）：**

1. **左导航 + 会话列表** 是 Agent 产品的标准骨架：一级模块常驻，会话是二级列表，且可按时间分组、可搜索。
2. **中央是「时间线」而非「聊天记录」**：一次用户输入产生的思考、工具、结果、最终回复属于同一 Turn，必须归组并分级视觉权重。
3. **右侧是工作现场**：计划、文件、变更、终端等上下文集中在可开关的侧栏，而不是塞进对话。
4. **底部 Composer 是唯一输入口**：多行输入、附件、指令菜单、模型选择、发送/停止都在这里，且全局快捷键可聚焦。
5. **渐进披露**：默认折叠过程，只留一行摘要（步数、工具数、耗时），点击展开细节。
6. **命令面板 + 快捷键**：高级用户用 ⌘K 和快捷键完成导航与操作，是「专业感」的关键来源。

---

## 4. 信息架构（IA）

### 4.1 一级模块

| 模块 | 图标（新增） | 路由 | 说明 |
| --- | --- | --- | --- |
| Chat | ChatBubbleIcon | /chat、/chat/:sessionId | 主舞台：会话 + 对话 + Composer |
| Tasks | ListBulletIcon | /tasks、/tasks/:taskId | 后台任务（已有 API） |
| Memory | SparklesIcon（或 BrainIcon 新增） | /memory | 记忆管理（已有 API） |
| Artifacts | DocumentDuplicateIcon（新增） | /artifacts | 产物/文件，本期占位 |
| Settings | CogIcon（已有） | /settings/* | 设置，本期先做「通用」一节，其余占位 |
| Help | QuestionMarkCircleIcon（新增） | 打开快捷键弹窗 | 快捷键与帮助 |

全局能力（不占导航位）：命令面板（⌘K）、通知中心、主题切换、账号菜单。

### 4.2 路由表

| 路由 | 视图 | 侧栏内容 | 右面板 |
| --- | --- | --- | --- |
| /login | LoginPage | 无 | 无 |
| /register | RegisterPage | 无 | 无 |
| /chat | ChatView（无会话空态） | 会话列表 | ContextPanel（可收起） |
| /chat/:sessionId | ChatView | 会话列表（高亮当前） | ContextPanel |
| /tasks | TasksView | 任务筛选（状态/来源） | 无 |
| /tasks/:taskId | TasksView + 详情抽屉 | 任务筛选 | 无 |
| /memory | MemoryView | 分类筛选 | 无 |
| /artifacts | ArtifactsView（ComingSoon） | 无 | 无 |
| /settings | SettingsView（General） | 设置分区 | 无 |
| /settings/:section | SettingsView | 设置分区 | 无 |
| * | NotFound | 无 | 无 |

导航与路由的关系：NavRail 点击切换一级路由；Sidebar 内容随一级模块变化；会话/任务/记忆的选中写入 URL（可深链、可刷新恢复、可前进后退）。

### 4.3 导航层级图

~~~
AppShell
├── NavRail（56px 常驻）
│   ├── Logo（回 /chat）
│   ├── Chat / Tasks / Memory / Artifacts          ← 一级模块
│   ├── ─────────
│   ├── Settings
│   └── 底部：主题切换 · 帮助 · 账号菜单
├── SidebarPane（280px，可折叠，内容随模块变化）
│   ├── Chat    → 新建会话 · 搜索 · 会话分组列表 · 用户footer
│   ├── Tasks   → 状态筛选 · 来源筛选
│   ├── Memory  → 分类筛选 · 标签筛选
│   └── Settings→ 分区列表（通用/模型/工具/权限/快捷键/关于）
├── MainPane
│   ├── HeaderBar（标题/面包屑 + 右侧动作 + 面板开关）
│   ├── 内容区
│   │   ├── Chat → ChatCanvas（阅读列 + Turn 时间线）
│   │   ├── Tasks → 表格/卡片
│   │   ├── Memory → 列表
│   │   └── Settings → 表单分区
│   └── Composer（仅 Chat）
├── ContextPanel（360px，仅 Chat，可开关）
│   └── Tabs：Plan · Files · Diff · Terminal · Memory
└── StatusBar（28px 常驻）
~~~

---

## 5. 布局方案

### 5.1 App Shell 栅格

| 区域 | 宽度 | 折叠 | 说明 |
| --- | --- | --- | --- |
| NavRail | 56px 固定 | 不可折叠（移动端改底部 Tab） | 一级模块图标 + Tooltip |
| SidebarPane | 280px（可拖拽 240–400） | 可收起到 0（⌘B） | 二级列表 |
| MainPane | flex: 1，min-width 480px | — | 阅读列 max 820px 居中；表格类全宽 |
| ContextPanel | 360px（可拖拽 280–520） | 可收起到 0（⌘J） | 仅 Chat |
| StatusBar | 28px 固定 | 不可折叠 | 全局状态 |

~~~
┌──────┬──────────────────────┬──────────────────────────────────────────────┬───────────────────┐
│      │                      │  HeaderBar 56                                 │                   │
│ Nav  │  SidebarPane 280     │  标题 · 面包屑        [模型▾][面板][分享][更多]│  ContextPanel 360 │
│ Rail │                      ├──────────────────────────────────────────────┤                   │
│ 56   │  [ + New Session   ] │                                              │  Plan | Files |   │
│      │  [ 搜索会话...      ]│        ChatCanvas（阅读列 max 820 居中）      │  Diff | Term |    │
│  聊  │                      │   ┌──────────────────────────────────────┐   │  Memory           │
│  任  │  Today               │   │ User message（右对齐气泡）            │   │                   │
│  记  │   · Session A        │   │ ▸ Thinking · 3 thoughts · 1.2s       │   │  ┌─────────────┐  │
│  产  │   · Session B        │   │ ▸ 4 tool calls   ✓3  ✗1              │   │  │ Goal 进度    │  │
│      │  Yesterday           │   │ Final reply（Markdown）              │   │  │ Plan 任务树  │  │
│      │   · Session C        │   └──────────────────────────────────────┘   │  └─────────────┘  │
│  设  │  Older               │                                              │                   │
│      │                      ├──────────────────────────────────────────────┤                   │
│      │  ── user / logout ── │  Composer  [+ 📎] [ 发消息或... ] [模型][↑]  │                   │
├──────┴──────────────────────┴──────────────────────────────────────────────┴───────────────────┤
│ ● Connected · deepseek-v4-pro · 12 steps · 8.2k tok · ~$0.03 · ctx 41% · ⌘K 命令 │ 08:31       │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
~~~

### 5.2 区域规范

**NavRail**
- 顶部：Logo（点击回 /chat，40×40 命中区）。
- 中部：模块按钮 40×40，图标 20px；active 态为「左侧 3px 高亮条 + 图标变 accent + 背景 accent-subtle」；hover 显示右侧 Tooltip（label + 快捷键）。
- 底部：主题切换、帮助（?）、账号头像（点击弹出 Menu：用户名 / 设置 / 登出）。
- 分隔线区分「模块 / 工具 / 账号」三组。

**SidebarPane**
- 标题行：模块名（14px semibold）+ 右侧操作图标（如新建、排序）。
- 搜索框：带 SearchIcon，Chat 模块搜索会话标题；支持 Ctrl/⌘+K 之外的第二入口。
- 列表：按 Today / Yesterday / Previous 7 days / Older 分组，组标题 11px 大写 tertiary；每项 36–40px 高。
- 会话项：状态点（运行中/等待审批）+ 标题（单行省略）+ 副标题（模型 · 相对时间）；hover 显示「更多」菜单（重命名/置顶/归档/删除）。
- 底部：用户信息 + 登出；固定不随列表滚动。
- 空态：图标 + 文案 + 主按钮（新建会话）。
- 加载态：3–5 行骨架屏。

**HeaderBar**
- 左：折叠按钮（☰/面板图标）、面包屑（模块 / 会话标题）、标题可双击重命名（占位可先只读）。
- 右：模型选择（CpuChipIcon + 名称 + ▾）、ContextPanel 开关、分享（占位）、更多菜单（重命名/导出/删除）。
- 高度 56px，底部 1px 边框；滚动时保持固定。

**ChatCanvas**
- 阅读列：max-width 820px，左右居中，两侧留白 ≥24px；代码块可横向滚动。
- Turn 间距 28px；User 消息右对齐气泡，Assistant 最终回复左对齐无气泡或极浅气泡（降低「聊天气泡感」，贴近 Claude/Cursor）。
- 顶部悬浮「回到最新」按钮；用户上滚时不强制吸底，出现「↓ 回到最新」。
- 虚拟化：Turn 数 > 50 时启用窗口化（可选，见 §10.5）。

**ContextPanel**
- 顶部 Tab：Plan / Files / Diff / Terminal / Memory；每个 Tab 用图标 + 短标签，超宽用 icon-only + Tooltip。
- 内容随会话实时更新；空态给出说明与下一步动作。
- 折叠后保留右侧 32px 竖条，点击展开（避免完全丢失入口）。

**StatusBar**
- 左：连接状态点 + 文案；当前模型。
- 中：Steps、Tokens、Context 占用（若有 context 事件）、成本。
- 右：⌘K 提示、当前时间/版本。
- 点击 Tokens/Context 弹出用量详情（占位 → 开发中）。

### 5.3 响应式断点

| 视口 | NavRail | SidebarPane | ContextPanel | 备注 |
| --- | --- | --- | --- | --- |
| ≥ 1536px | 展开 | 展开 280 | 展开 360 | 完整三区 |
| 1280–1535px | 展开 | 展开 280 | 默认收起（可手动开） | 保证阅读列宽度 |
| 1024–1279px | 展开 | 覆盖式抽屉（点击遮罩关闭） | 覆盖式抽屉（右滑入） | 主区优先 |
| 768–1023px | 底部 Tab 或收窄 56 | 抽屉 | 抽屉 | 平板 |
| < 768px | 底部 Tab | 全屏抽屉 | 全屏抽屉 | 移动端，Composer 吸底，安全区内边距 |

折叠状态持久化到 localStorage（键 yo-ui-prefs），刷新后保持。

### 5.4 键盘与快捷键

| 快捷键 | 行为 |
| --- | --- |
| ⌘/Ctrl + K | 打开命令面板 |
| ⌘/Ctrl + B | 折叠/展开 SidebarPane |
| ⌘/Ctrl + J | 折叠/展开 ContextPanel |
| ⌘/Ctrl + Enter | 发送消息（输入框内） |
| Enter | 换行（Composer 设为 Shift+Enter 发送可选；默认 Enter 发送、Shift+Enter 换行，与现状一致） |
| / | 聚焦 Composer 并唤起指令菜单 |
| Esc | 关闭最上层浮层（面板/弹窗/菜单） |
| ? | 打开快捷键帮助 |

快捷键集中定义在 config/shortcuts.ts，便于帮助面板与命令面板共用。

### 5.5 关键视图线框

**Chat 空态（无会话）**

~~~
┌──────────────────────────────────────────────────────────┐
│                    (Logo / Sparkles)                     │
│              开始你的第一个会话                            │
│        选择一个模型，描述你的任务，Agent 会开始工作。      │
│                [ + 新建会话 ]                             │
│   快捷示例：  调研一个主题 · 读代码库 · 写一个脚本         │
└──────────────────────────────────────────────────────────┘
~~~

**Chat 空态（有会话无消息）**

~~~
        [ 在此会话中开始 ]
   Composer 已聚焦，输入 / 查看指令，输入 @ 引用文件或会话
~~~

**Tasks**

~~~
Tasks                                  [刷新] [筛选▾]
┌────────┬──────────────────┬────────┬──────────┬────────────┬────────┐
│ ID     │ 描述             │ 状态   │ 模型     │ 创建时间   │ 操作   │
├────────┼──────────────────┼────────┼──────────┼────────────┼────────┤
│ a1b2…  │ 每日构建摘要     │ ● 运行 │ v4-pro   │ 10 分钟前  │ 取消   │
│ c3d4…  │ 回归测试         │ ✓ 完成 │ v4-flash │ 昨天       │ 查看   │
└────────┴──────────────────┴────────┴──────────┴────────────┴────────┘
空态：暂无后台任务 · 在 CLI 用 yo bg 或对话中创建
~~~

**Memory**

~~~
Memory Manager                         [+ 新建记忆]
[ 搜索记忆...        ] [ 分类▾ ] [ 状态▾ ]
general / preference / environment / project_knowledge 分组或徽标
┌─────────────────────────────────────────────────────────┐
│ 标题                              [偏好]  ·  2 天前      │
│ 内容摘要（2 行省略）                                     │
│ #关键字1  #关键字2                     [编辑] [删除]      │
└─────────────────────────────────────────────────────────┘
~~~

**Settings（本期只做 General）**

~~~
Settings
├── General        主题（浅色/深色/跟随系统）、语言（占位）、密度（舒适/紧凑）
├── Models         Provider / API Key / 模型角色           ← 占位（开发中）
├── Tools & MCP    MCP 服务器管理                          ← 占位（开发中）
├── Permissions    审批策略 / 允许工具 / 沙箱              ← 占位（开发中）
├── Shortcuts      快捷键表（可做真实只读表）
└── About          版本 / 仓库 / 许可
~~~

---

## 6. 组件规范

### 6.0 组件清单总览

| 层 | 组件 | 优先级 | 新建/改造 |
| --- | --- | --- | --- |
| 布局 | AppShell | P0 | 新建 |
| 布局 | NavRail | P0 | 新建 |
| 布局 | SidebarPane | P0 | 新建（复用 Sidebar 内容） |
| 布局 | HeaderBar | P0 | 新建（替代 TopBar） |
| 布局 | ContextPanel | P1 | 新建 |
| 布局 | StatusBar | P1 | 改造 |
| 基础 | Button / IconButton | P0 | 新建（替换裸 btn） |
| 基础 | Tooltip | P0 | 新建 |
| 基础 | Tabs / Segmented | P1 | 新建 |
| 基础 | Menu / DropdownMenu | P0 | 新建 |
| 基础 | Badge / StatusDot | P1 | 新建 |
| 基础 | Toast / NotificationCenter | P0 | 新建 |
| 基础 | EmptyState / Skeleton / ErrorState | P0 | 新建 |
| 基础 | Modal / Drawer | P1 | 新建 |
| 基础 | CommandPalette | P1 | 新建 |
| 基础 | ComingSoon（占位） | P0 | 新建 |
| 对话 | TurnBlock | 已有 | 增强 |
| 对话 | ThinkingSection | 已有 | 增强（摘要行加图标/耗时格式） |
| 对话 | ToolSteps / ToolStep | 已有 | 增强（状态点、结果折叠、diff 预览位） |
| 对话 | Composer | P0 | 重构 ChatArea 输入区 |
| 对话 | SlashMenu / MentionMenu | P1 | 新建 |
| 对话 | MessageActions | P1 | 新建 |
| 对话 | GoalBanner / ContextChips | P1 | 新建 |
| 面板 | PlanPanel（复用 PlanView） | P1 | 接线 |
| 面板 | FilesPanel / DiffPanel / TerminalPanel | P1 | 占位 |
| 面板 | MemoryPanel（引用记忆列表） | P2 | 新建 |
| 业务 | SessionList / SessionListItem | P0 | 改造 |
| 业务 | TasksView | P1 | 改造 |
| 业务 | MemoryView | P1 | 改造 |
| 业务 | ApprovalCard + ApprovalDialog | P0 | 改造 |
| 业务 | SettingsView | P1 | 新建 |

通用约定：所有组件使用语义 className（BEM 风格，如 .tool-step__status），样式统一放 styles 目录；所有图标来自 components/Icons，禁止在业务组件里内联 SVG。

---

### 6.1 AppShell

- **用途**：承载全局四区栅格与折叠状态。
- **结构**：NavRail + SidebarPane + MainPane + ContextPanel + StatusBar + 全局浮层（CommandPalette / Toast / ApprovalDialog）。
- **状态**：sidebarCollapsed、contextPanelOpen、sidebarWidth、contextWidth；持久化到 localStorage。
- **交互**：⌘B / ⌘J；拖拽分隔条调整宽度；窄屏自动切换为抽屉。
- **文件**：layout/AppShell.tsx、layout/AppShell.css 或 styles/layout.css。

### 6.2 NavRail

- **结构**：分组（模块 / 工具 / 账号），每组内按钮 40×40。
- **状态**：active（由当前路由推导）、hover、focus-visible。
- **交互**：点击导航；hover 出 Tooltip（含快捷键，如 Tasks ⌘2）；账号按钮弹 Menu。
- **文件**：layout/NavRail.tsx。
- **无障碍**：外层 nav + aria-label；按钮 aria-current=page。

### 6.3 SidebarPane 与 SessionListItem

- **结构**：Header（标题 + 操作）→ SearchInput → 分组列表 → Footer 用户区。
- **分组规则**：Today / Yesterday / Previous 7 days / Older，由 updatedAt 计算，纯前端。
- **SessionListItem**：
  - 左：状态点（idle/running/waiting 三态，running 呼吸动画）。
  - 中：标题（单行省略，hover 显示全文 Tooltip）、副标题（模型 · 相对时间，如「3 分钟前」）。
  - 右：hover/聚焦时出现 MoreMenu（重命名/置顶/归档/复制链接/删除）。
  - active 态：左侧 3px accent 条 + accent-subtle 背景。
- **交互**：点击选中并写入 /chat/:id；Delete 需二次确认（非原生 confirm，用统一 Modal）。
- **文件**：Sidebar/SessionList.tsx、Sidebar/SessionListItem.tsx（替代 SessionItem.tsx）。
- **无障碍**：列表用 ul/li；项为 button 或带 role=option 的 div，支持上下键移动（可选）。

### 6.4 HeaderBar

- **结构**：左（SidebarToggleButton、Breadcrumb/Title）；右（ModelPicker、ContextPanelToggle、ShareButton、MoreMenu）。
- **状态**：标题加载中显示 Skeleton；无会话时显示模块名。
- **交互**：模型切换即时生效并提示（Toast 轻提示）；更多菜单含重命名（占位）、导出（占位）、删除（真实）。
- **文件**：layout/HeaderBar.tsx、Model/ModelPicker.tsx（替代 ModelSelector）。
- **依赖**：GET /api/v1/models（含 roles，可用于分组）。

### 6.5 Composer

- **结构**：
  ~~~
  ┌─────────────────────────────────────────────────────────────┐
  │ [附件 chip 区 / 引用 chip 区]                                │
  │ 发消息或创建任务，输入 / 调用指令，@ 引用文件或会话           │
  │                                    [模型▾] [停止■|发送↑]     │
  └─────────────────────────────────────────────────────────────┘
  toolbar: [+ 添加] [/ 指令] [@ 引用] [📎 附件] [🎤 语音]        │
  ~~~
- **状态**：idle / composing / sending（发送变停止）/ disabled（无会话）。
- **交互**：
  - 输入 / 唤起 SlashMenu（本期仅列出指令，选中后插入文本或提示开发中）。
  - 输入 @ 唤起 MentionMenu（占位 → 开发中）。
  - 附件、语音、+ 菜单：占位 → 开发中。
  - 发送：POST /api/v1/sessions/:id/messages；发送中显示停止按钮，点击调用 /interrupt（真实接口）。
  - 自动增高（1–8 行，超出滚动）。
- **文件**：Chat/Composer.tsx、Chat/SlashMenu.tsx、Chat/MentionMenu.tsx。
- **无障碍**：textarea 关联 label；指令菜单支持上下键选择、Enter 确认、Esc 关闭。

### 6.6 TurnBlock（增强）

- **现状**：已渲染 UserMessage + Error + ThinkingSection + ToolSteps + FinalReply + TurnMeta。
- **增强点**：
  1. 最终回复去掉厚重气泡，改为左对齐正文 + 可选浅底，提升长文可读性。
  2. TurnMeta 增加来源 chip：Context 压缩/裁剪、Memory 提取/注入、Checkpoint 创建（见 §9）。
  3. 增加 MessageActions 行（hover 出现）：复制、重试（占位）、编辑（占位）、分支（占位）、反馈（占位）。
  4. 失败 Turn 增加「重试」入口（真实调用重新发送相同内容，或占位）。
- **文件**：Chat/TurnBlock.tsx。

### 6.7 ThinkingSection（增强）

- **现状**：折叠摘要 + 展开 Markdown。
- **增强点**：摘要行改为「Thinking · 3 thoughts · 1.2s」，加 BrainSpark 图标；展开态默认折叠且不抢焦点；长文本限高并可滚动；支持「正在思考」动态态（基于 turn 未结束 + 无 tool_result 推断，不依赖流式）。
- **文件**：Chat/ThinkingSection.tsx。

### 6.8 ToolSteps / ToolStep（增强）

- **现状**：折叠组 + 每个 step 显示状态图标、工具名、参数摘要、结果文本。
- **增强点**：
  1. 状态用彩色圆点 + 文案（Running / OK / Failed / Waiting approval），而非仅图标。
  2. 参数与结果各自可折叠；结果按内容类型渲染（JSON 折叠树、文本等宽、diff 着色）。
  3. 结果为 write/edit 类工具时，预留 DiffPreview 区域（本期可显示变更摘要，真实 diff 占位）。
  4. 等待审批的 step 内嵌 Approve/Reject 按钮（与 ApprovalCard 复用）。
  5. 复制结果按钮。
- **文件**：Chat/ToolSteps.tsx、Chat/ToolResultView.tsx（新建）。

### 6.9 MessageActions

- **结构**：一行小图标按钮（复制 / 重试 / 编辑 / 分支 / 赞踩），hover 或聚焦时出现。
- **行为**：复制为真实；重试/编辑/分支/反馈 → 开发中 Toast。
- **文件**：Chat/MessageActions.tsx。

### 6.10 PlanPanel / GoalBanner

- **PlanPanel**：复用已有 PlanView，放入 ContextPanel 的 Plan Tab；并在 turn 内对应位置插入一条「Plan 已生成」的可展开卡片。
- **GoalBanner**：当收到 goal_reminder 时，在对话顶部显示一条细横幅：「当前目标：…（已 N 步无进展）」+ 查看/编辑（编辑占位）。
- **文件**：Plan/PlanPanel.tsx、Chat/GoalBanner.tsx。

### 6.11 ContextPanel 与各 Tab

| Tab | 内容 | 数据来源 | 本期 |
| --- | --- | --- | --- |
| Plan | 目标 + 任务树 + 进度条 + 验收标准 | plan_* 事件 | 真实（有则显示，无则空态） |
| Files | 会话涉及的变更文件列表 | checkpoint_created 事件 | 半真实（有则列出），打开文件/文件树占位 |
| Diff | 变更 diff 查看器 | 依赖后端 | 占位（开发中） |
| Terminal | 沙箱终端 | 依赖后端 | 占位（开发中） |
| Memory | 本会话注入/提取的记忆 | memory_injected / memory_extracted + API | 半真实 |

- **文件**：layout/ContextPanel.tsx、panels/PlanPanel.tsx、panels/FilesPanel.tsx、panels/DiffPanel.tsx、panels/TerminalPanel.tsx、panels/MemoryPanel.tsx。

### 6.12 ApprovalCard + ApprovalDialog

- **ApprovalCard**：内嵌在等待审批的 ToolStep 内，显示工具名、摘要、args 预览、[允许一次] [本会话允许] [拒绝]。
- **ApprovalDialog**：保留模态形式（用于非当前会话或卡片不便的场景），样式与 Card 统一。
- **交互**：WS approval.resolve；resolve 后卡片变结果态。
- **文件**：Approval/ApprovalCard.tsx、Approval/ApprovalDialog.tsx。

### 6.13 CommandPalette

- **结构**：居中浮层，SearchInput + 分组结果（导航 / 会话 / 动作 / 帮助）。
- **数据**：静态命令表 + 会话列表；输入过滤；上下键选择，Enter 执行。
- **本期**：导航类命令真实；其余命令标注「开发中」，执行后 Toast。
- **文件**：components/ui/CommandPalette.tsx、config/commands.ts。

### 6.14 Toast / NotificationCenter

- **Toast**：右下角堆叠，4 种类型（info/success/warning/error），自动消失（error 不自动消失），可手动关闭。
- **NotificationCenter**：右侧抽屉，记录历史通知（本期可只存内存）。
- **文件**：components/ui/Toast.tsx、stores/toast.ts、components/ui/NotificationCenter.tsx。

### 6.15 EmptyState / Skeleton / ErrorState

- **EmptyState**：图标 + 标题 + 描述 + 主/次操作，统一尺寸与留白。
- **Skeleton**：行/块两种，用于会话列表、对话加载、表格。
- **ErrorState**：图标 + 错误信息 + 重试按钮；替代现有 catch {} 静默。
- **文件**：components/ui/EmptyState.tsx、Skeleton.tsx、ErrorState.tsx。

### 6.16 ComingSoon（占位）

见 §7.2。

### 6.17 StatusBar（改造）

- **结构**：左（连接状态、模型）· 中（Steps / Tokens / Context / Cost）· 右（⌘K 提示、时间）。
- **交互**：点击 Tokens/Context/Cost → 弹出用量详情（占位）。
- **文件**：StatusBar/StatusBar.tsx。

---

## 7. 功能缺口与「开发中」占位策略

### 7.1 缺口清单

| # | 功能 | 建议入口 | 点击行为 | 数据依赖 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| 1 | 全局命令面板 | ⌘K / 状态栏提示 | 真实导航 + 占位命令提示开发中 | 前端 | P1 |
| 2 | 会话搜索 | Sidebar 搜索框 | 真实（前端过滤已有列表；服务端搜索占位） | 前端 | P1 |
| 3 | 会话重命名/置顶/归档/复制链接 | 会话项 MoreMenu | 重命名可用（本地+后续接口）/其余开发中 | 前端 | P1 |
| 4 | 会话按时间分组 | Sidebar 列表 | 真实 | 前端 | P1 |
| 5 | 附件上传（文件/图片） | Composer 📎 / + | 开发中 | 后端 | P2 |
| 6 | @ 引用文件或会话 | Composer 输入 @ | 开发中 | 后端 | P2 |
| 7 | / 指令菜单 | Composer 输入 / | 列出 CLI 已有指令，执行 → 开发中 | 后端/前端 | P1 |
| 8 | 语音输入 | Composer 🎤 | 开发中 | 浏览器 API | P2 |
| 9 | Artifacts / 产物 | NavRail 模块 | 打开模块页，页内 ComingSoon | 后端 | P1 |
| 10 | Files 文件树 | ContextPanel Files | 列出变更文件（真实）；打开文件开发中 | 半后端 | P1 |
| 11 | Diff 查看与接受/拒绝 | ContextPanel Diff | 开发中 | 后端 | P1 |
| 12 | 终端 | ContextPanel Terminal | 开发中 | 后端 | P1 |
| 13 | 检查点 / 撤销 / 重做 | HeaderBar 更多 / 命令面板 | 开发中（事件已可显示 checkpoint chip） | 后端 | P2 |
| 14 | Goal 查看/编辑 | GoalBanner / 命令面板 | 查看真实；编辑开发中 | 后端 | P2 |
| 15 | MCP 服务器管理 | Settings → Tools & MCP | 开发中 | 后端 | P2 |
| 16 | Provider / API Key / 模型角色 | Settings → Models | 开发中 | 后端（接口已有） | P2 |
| 17 | 权限与沙箱策略 | Settings → Permissions | 开发中 | 后端 | P2 |
| 18 | 用量与成本详情 | StatusBar 用量 / Settings | 开发中 | 后端 | P2 |
| 19 | 分享 / 导出会话 | HeaderBar 分享 | 开发中 | 后端 | P2 |
| 20 | 通知中心 | NavRail/HeaderBar 铃铛 | 开发中（Toast 历史可真实） | 前端 | P2 |
| 21 | 快捷键帮助 | ? / 帮助 | 真实（只读表） | 前端 | P1 |
| 22 | 账号/团队/管理端 | 账号菜单 | 开发中 | 后端 | P3 |
| 23 | 跟随系统主题 / 界面密度 | Settings → General | 真实 | 前端 | P1 |
| 24 | 逐字流式输出 | 对话区 | 依赖后端 llm_delta，列开放问题 | 后端 | 后续 |

### 7.2 统一占位方案

**原则**：占位不是「无」，而是「有入口、有说明、有反馈」。任何未实现的功能都必须：

1. 有图标与 label（或 Tooltip）；
2. 点击后给出明确反馈：默认 Toast「{功能名} 正在开发中」；
3. 对成片的模块（Artifacts、Settings 的某些分区、ContextPanel 的 Diff/Terminal），使用页内 EmptyState 风格占位：图标 + 「功能开发中」+ 一句话描述它能做什么 + 「了解计划」按钮（打开同一 Toast 或文档链接）。

**状态分级**：功能注册表用三态区分，避免把「已有后端但前端没接」与「纯规划」混为一谈。

~~~
// packages/web/src/config/features.ts（示意）
export type FeatureStatus = 'live' | 'wip' | 'planned';

export interface FeatureEntry {
  id: string;              // 'diff' | 'terminal' | 'artifacts' | ...
  label: string;           // 展示名
  description: string;     // 一句话说明
  icon: string;            // Icons 中的导出名
  status: FeatureStatus;
  entry: 'nav' | 'sidebar' | 'header' | 'composer' | 'panel' | 'palette' | 'settings';
}

export const FEATURES = {
  artifacts: { id: 'artifacts', label: 'Artifacts', description: '查看与下载 Agent 产出的文件', icon: 'DocumentDuplicateIcon', status: 'wip', entry: 'nav' },
  diff:      { id: 'diff',      label: 'Diff',      description: '查看并接受/拒绝文件变更',     icon: 'CodeBracketIcon',      status: 'wip', entry: 'panel' },
  terminal:  { id: 'terminal',  label: 'Terminal',  description: '在沙箱中运行命令',           icon: 'TerminalIcon',         status: 'wip', entry: 'panel' },
  // ...
} as const;
~~~

**统一出口**：

~~~
// components/ui/ComingSoon.tsx
// 两种用法：
//   <ComingSoon feature="diff" />                      → 页内占位块
//   const comingSoon = useComingSoon(); comingSoon('diff') → Toast 反馈
//
// Toast 文案统一为：  {label} 正在开发中，敬请期待
~~~

**可关闭开关**：features.ts 中的 status 一旦改为 live，对应入口自动切换为真实实现（组件内按 status 分支），无需改动布局，避免二次返工。

---

## 8. 设计系统（Design Tokens）

现有 token 只有一组基础色，缺少「海拔（surface elevation）」「diff」「代码/终端」等语义层级。本节给出完整 token 定义，作为 styles/tokens.css 的唯一来源。所有组件样式只允许引用 token，不允许出现裸色值。

### 8.1 色彩

**语义角色（浅色 / 深色）**

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| --bg-canvas | #ffffff | #0b0b0f | 应用最底层背景 |
| --bg-surface | #f7f7f8 | #131318 | 侧栏、面板 |
| --bg-surface-raised | #ffffff | #1a1a21 | 卡片、弹层、菜单 |
| --bg-surface-sunken | #f0f0f2 | #0f0f14 | 输入框、代码块底 |
| --bg-hover | #f0f0f2 | #1e1e26 | hover 背景 |
| --bg-active | #e8e8ec | #2a2a34 | 选中/按下背景 |
| --bg-overlay | rgba(15,15,20,.45) | rgba(0,0,0,.6) | 模态遮罩 |
| --border-subtle | #ececf0 | #1e1e26 | 分隔线 |
| --border-default | #e0e0e6 | #2a2a34 | 卡片/输入边框 |
| --border-strong | #c9c9d2 | #3a3a46 | 强调边框、拖拽把手 |
| --text-primary | #18181b | #ececf1 | 正文 |
| --text-secondary | #52525b | #a1a1ab | 次要文本 |
| --text-tertiary | #a1a1aa | #6b6b76 | 占位、元信息 |
| --text-disabled | #d4d4d8 | #4a4a55 | 禁用 |
| --text-inverse | #ffffff | #0b0b0f | 深底上的文字 |
| --accent | #4f6ef7 | #6b83ff | 主色（沿用现有品牌色） |
| --accent-hover | #3b5de7 | #8095ff | hover |
| --accent-active | #2f4cd4 | #5a74f0 | active |
| --accent-subtle | #eef1ff | #1c2140 | 选中背景、active 导航底 |
| --accent-contrast | #ffffff | #0b0b0f | 主色上的文字 |
| --success | #16a34a | #34d399 | 成功 |
| --success-subtle | #ecfdf3 | rgba(52,211,153,.14) | 成功底 |
| --warning | #d97706 | #fbbf24 | 警告/等待 |
| --warning-subtle | #fffbeb | rgba(251,191,36,.14) | 警告底 |
| --danger | #dc2626 | #f87171 | 失败/危险 |
| --danger-subtle | #fef2f2 | rgba(248,113,113,.14) | 危险底 |
| --info | #2563eb | #60a5fa | 信息 |
| --focus-ring | rgba(79,110,247,.45) | rgba(107,131,255,.55) | focus 外圈 |

**内容与代码**

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| --code-bg | #f4f4f5 | #12121a | inline/块级代码底 |
| --code-text | #27272a | #e4e4e7 | 代码文字 |
| --terminal-bg | #0b0b0f | #0b0b0f | 终端底（深浅色统一为暗） |
| --terminal-fg | #e4e4e7 | #e4e4e7 | 终端文字 |
| --diff-add-bg | #dcfce7 | rgba(52,211,153,.14) | 新增行底 |
| --diff-add-text | #166534 | #6ee7b7 | 新增行文字 |
| --diff-del-bg | #fee2e2 | rgba(248,113,113,.14) | 删除行底 |
| --diff-del-text | #991b1b | #fca5a5 | 删除行文字 |
| --diff-context-text | #52525b | #a1a1ab | diff 上下文行 |

深色模式遵守「避免全黑、提供可分辨海拔」的通用经验：canvas #0b0b0f / surface #131318 / raised #1a1a21 / sunken #0f0f14。

### 8.2 字体

| Token | 值 |
| --- | --- |
| --font-sans | Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif |
| --font-mono | ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace |
| --text-2xs | 11px / 1.4（元信息、组标题） |
| --text-xs | 12px / 1.45（表格、徽标） |
| --text-sm | 13px / 1.5（侧栏、按钮、面板） |
| --text-base | 14px / 1.6（正文、对话回复） |
| --text-lg | 16px / 1.5（卡片标题、区块标题） |
| --text-xl | 20px / 1.35（页面标题） |
| --text-2xl | 24px / 1.3（空态主标题） |

权重：400 / 500 / 600 / 700。正文字重 400，UI 标签 500，标题 600。

**术语收敛**（现状中英混排）：模块名保留英文（Chat/Tasks/Memory/Artifacts/Settings，产品调性），动作与状态用中文（新建会话、发送、复制、重试、运行中、等待审批、已完成、失败）。状态徽标统一二选一，建议中文。

### 8.3 间距

基于 4px 栅格：--space-1 4 / 2 8 / 3 12 / 4 16 / 5 20 / 6 24 / 8 32 / 10 40 / 12 48。
区域内部 padding：Sidebar 12/16；HeaderBar 横向 16；对话阅读列横向 24；ContextPanel 16；Composer 12/16。

### 8.4 圆角 / 边框 / 阴影

| Token | 值 |
| --- | --- |
| --radius-xs | 4px（徽标、tag） |
| --radius-sm | 6px（按钮、输入） |
| --radius-md | 8px（卡片、会话项） |
| --radius-lg | 12px（面板、弹层） |
| --radius-xl | 16px（Composer 容器） |
| --radius-full | 999px（状态点、头像） |
| --shadow-xs | 0 1px 2px rgba(0,0,0,.05) |
| --shadow-sm | 0 1px 3px rgba(0,0,0,.08) |
| --shadow-md | 0 4px 12px rgba(0,0,0,.10) |
| --shadow-lg | 0 12px 32px rgba(0,0,0,.14) |
| --focus-ring-style | 0 0 0 2px var(--bg-canvas), 0 0 0 4px var(--focus-ring) |

深色阴影透明度提高（.3–.5），确保层级仍可辨。

### 8.5 动效

| Token | 值 | 用途 |
| --- | --- | --- |
| --motion-fast | 120ms | hover、颜色变化 |
| --motion-base | 180ms | 折叠、面板开合 |
| --motion-slow | 260ms | 抽屉、模态 |
| --ease-standard | cubic-bezier(.2,.8,.2,1) | 默认 |
| --ease-out | cubic-bezier(0,.6,.3,1) | 进入 |
| --ease-in | cubic-bezier(.4,0,1,1) | 退出 |

统一尊重 prefers-reduced-motion：命中时全部动效降为 0ms（保留可见性变化）。

### 8.6 图标规范

- 统一 24×24 viewBox、stroke-width 1.5、currentColor；颜色继承文本色。
- 常用展示尺寸：16px（行内/按钮）、20px（导航/工具步骤）、24px（空态）。
- 所有图标集中在 components/Icons/Icons.tsx 并从 index.ts 导出；新增图标见附录 A。
- 图标按钮必须有 aria-label 或可见文字，禁止无标签图标按钮。

### 8.7 组件状态规范

| 状态 | 视觉 |
| --- | --- |
| hover | 背景 --bg-hover；图标/文字不变色（除非可点击主色） |
| focus-visible | --focus-ring-style 外圈，绝不 outline:none 后不补 |
| active | 背景 --bg-active，轻微 scale(.98)（120ms） |
| selected/active | --accent-subtle 背景 + 左侧 3px accent 条（列表类）或 accent 填充（Tab 类） |
| disabled | 透明度 .5，cursor not-allowed，不可聚焦 |
| loading | Skeleton 或 Spinner，禁止仅改变文案 |

---

## 9. 事件到 UI 的完整映射

core 定义了 22 种 AgentEvent。现状只有约 8 种进入渲染，其余被丢弃。完整映射如下（P0 必做 / P1 建议 / P2 可延后）。

| 事件 | 渲染位置 | 优先级 |
| --- | --- | --- |
| session_started | HeaderBar 元信息（model · cwd）、ContextPanel Memory 头 | P1 |
| user_input | TurnBlock 用户消息 | 已有 |
| assistant_text | 非最后一个 → ThinkingSection；最后一个 → FinalReply；其 toolCalls 挂到对应 ToolStep | 已有 |
| tool_call | ToolStep（Running） | 已有 |
| tool_result | ToolStep 结果（OK/Failed + 耗时） | 已有 |
| approval_request | ToolStep 内嵌 ApprovalCard（Waiting approval） | P0 |
| approval_result | ToolStep 状态徽标（approved once/session / rejected） | P1 |
| turn_started | Turn 边界 | 已有 |
| turn_completed | TurnMeta（reason + usage），reason 非 done 时用颜色提示 | P1 |
| error | Turn 内 ErrorBanner（stage + message + 重试） | 已有（增强） |
| context_elided | TurnMeta 旁 chip：「已裁剪 N 条 · 释放 ~X tokens」 | P1 |
| context_compressed | TurnMeta 旁 chip：「已压缩 N 条 · X→Y tokens」 | P1 |
| checkpoint_created | TurnMeta 旁 chip「已创建检查点」+ ContextPanel Files 列表 | P1 |
| checkpoint_restored | chip「已回滚/重做 · N 文件」 | P1 |
| plan_created | ContextPanel Plan Tab + Turn 内 PlanCard | P1 |
| plan_approved | Plan 面板状态 | P1 |
| plan_rejected | Plan 面板状态 + 原因 | P1 |
| plan_task_updated | Plan 面板进度条与任务树 | P1 |
| goal_reminder | 顶部 GoalBanner（目标 + 无进展步数） | P2 |
| memory_extracted | TurnMeta 旁 chip「提取 N 条记忆」+ Memory 面板刷新 | P2 |
| memory_injected | chip「注入 N 条记忆」+ Memory 面板高亮 | P2 |
| task_started / completed / failed | Tasks 模块实时刷新 + 状态栏任务指示；对话内可选插入任务 chip | P2 |

**低优先级事件的收纳原则**：一律进 TurnMeta 行的 chip 组（icon + 短文案 + Tooltip 详情），点击 chip 打开对应 ContextPanel Tab。既不丢信息，也不打断阅读。

---

## 10. 前端架构调整

### 10.1 目录结构（目标）

~~~
packages/web/src/
├── app/
│   ├── App.tsx                 # Router + Providers
│   └── routes.tsx              # 路由表
├── layout/
│   ├── AppShell.tsx
│   ├── NavRail.tsx
│   ├── SidebarPane.tsx
│   ├── HeaderBar.tsx
│   ├── ContextPanel.tsx
│   └── StatusBar.tsx
├── features/
│   ├── chat/ Composer.tsx ChatView.tsx TurnBlock.tsx ThinkingSection.tsx
│   │          ToolSteps.tsx ToolResultView.tsx MessageActions.tsx
│   │          SlashMenu.tsx MentionMenu.tsx GoalBanner.tsx
│   ├── sessions/ SessionList.tsx SessionListItem.tsx
│   ├── tasks/ TasksView.tsx TaskDetail.tsx
│   ├── memory/ MemoryView.tsx
│   ├── plan/ PlanPanel.tsx PlanView.tsx
│   ├── approvals/ ApprovalCard.tsx ApprovalDialog.tsx
│   ├── artifacts/ ArtifactsView.tsx
│   └── settings/ SettingsView.tsx sections/
├── components/ui/               # 无业务的基础组件
│   Button.tsx IconButton.tsx Tabs.tsx Tooltip.tsx Menu.tsx Toast.tsx
│   Modal.tsx Drawer.tsx EmptyState.tsx Skeleton.tsx ErrorState.tsx
│   ComingSoon.tsx CommandPalette.tsx Badge.tsx StatusDot.tsx
├── stores/  session.ts ui.ts toast.ts approval.ts auth.ts
├── api/     client.ts websocket.ts
├── config/  features.ts shortcuts.ts commands.ts navigation.ts
├── hooks/   useSession.ts useTheme.ts useWebSocket.ts useMediaQuery.ts useClickOutside.ts
├── utils/   turn-grouping.ts time.ts format.ts
└── styles/  tokens.css base.css layout.css components.css chat.css panels.css
~~~

迁移策略：目录重组可与功能开发分两批进行（先建新壳并保留旧目录，逐个搬移，最后删除旧文件），避免一次性大改导致不可回归。

### 10.2 状态管理

| Store | 职责 |
| --- | --- |
| sessionStore | 会话列表、当前会话、事件缓冲（现状延续，增加 loading/error 粒度） |
| uiStore | 侧栏折叠、面板开关与宽度、当前 Tab、主题偏好（替代散落 useState） |
| toastStore | Toast 队列与历史 |
| approvalStore | 待审批队列（现状延续） |
| authStore | 认证（现状延续） |

约定：错误不再静默。API 层失败统一 dispatch 到 toastStore，同时相关视图进入 error 态。

### 10.3 路由与数据流

- 选中会话 = 路由参数 /chat/:sessionId；selectSession 由路由 effect 驱动，组件不直接切换。
- 事件缓冲仍按 sessionId 存 Map；订阅与退订跟随路由。
- 深链恢复：进入 /chat/:id 时先 GET 会话与历史事件，再订阅 WS。

### 10.4 样式策略

- 保留 CSS 变量 + 手写类名，但按域拆分为多个 CSS 文件（tokens/base/layout/components/chat/panels），在 main.tsx 顺序引入。
- 引入 focus-visible 统一规则与 prefers-reduced-motion 媒体查询到 base.css。
- 禁用裸色值：新增样式必须引用 token（可在 CI 加一条简单 grep 检查，作为后续增强）。

### 10.5 可访问性与性能

- 可点击 div 一律改 button，或补 role/tabIndex/onKeyDown；列表用语义标签。
- 流式/状态变化区域加 aria-live="polite"；模态用 role=dialog + aria-modal，打开时焦点陷阱、Esc 关闭、关闭后焦点归还触发元素。
- 长会话：Turn 数超过 50 时按需渲染（简单窗口化）；Markdown 渲染 memo 化（React.memo + 只在文本变化时重渲染）。
- 图片/字体懒加载；骨架屏避免布局抖动（预留高度）。

---

## 11. 实施路线图

> 每个阶段结束都应可运行、可截图回归；不允许跨阶段留「半成品界面」。

### Phase 0 — 基线与脚手架（0.5 天）
- 建立本设计文档对应的样式目录与 token 文件（不改变现有视觉）。
- 引入基础组件：Button/IconButton/Tooltip/EmptyState/Skeleton/ErrorState/Toast + toastStore。
- 产出：styles/tokens.css、components/ui/*、stores/toast.ts。
- 验收：现有页面外观不变，typecheck/lint/test 通过。

### Phase 1 — App Shell 骨架（2–3 天）
- 新建 AppShell、NavRail、SidebarPane、HeaderBar、ContextPanel（先空壳）、StatusBar 改造。
- 路由化：/chat、/chat/:sessionId、/tasks、/memory、/artifacts、/settings。
- uiStore 接管折叠状态 + localStorage 持久化；快捷键 ⌘B/⌘J/⌘K（⌘K 先打开空面板）。
- 响应式：1536 / 1280 / 1024 三档。
- 验收：刷新保持路由与折叠态；前进后退可用；1024 宽无横向滚动。

### Phase 2 — 侧栏与导航信息密度（2 天）
- SessionList 分组 + 搜索 + MoreMenu（重命名可用，其余占位）。
- SessionListItem 状态点、相对时间、active 条。
- 空态/骨架屏接入。
- 验收：新建/切换/删除/重命名闭环；搜索即时过滤。

### Phase 3 — 对话区打磨（2–3 天）
- Composer 重构：多行自增高、发送/停止（接 interrupt）、/ 与 @ 菜单（选中提示开发中）、附件/语音占位。
- TurnBlock 视觉分层（最终回复去重气泡）、MessageActions、复制可用。
- ToolStep 增强：状态点文案、结果折叠、复制、审批内嵌。
- 验收：一次完整对话的思考/工具/结果/回复层级清晰；停止按钮可中断。

### Phase 4 — 上下文面板（2–3 天）
- ContextPanel Tabs：Plan（真实）、Files（半真实）、Memory（半真实）、Diff/Terminal（ComingSoon）。
- PlanView 正式接线；事件 → 面板的数据流；TurnMeta chip 组。
- 验收：触发 /plan 或收到 plan 事件时面板显示任务树与进度；无数据时给出清晰空态。

### Phase 5 — 占位完整性与命令面板（1–2 天）
- 全局接入 ComingSoon：NavRail（Artifacts）、HeaderBar（分享）、Composer（附件/语音/@）、Settings 分区、StatusBar 用量。
- CommandPalette 真实导航 + 占位命令。
- 通知中心（内存版）。
- 验收：遍历全站无「点击无反应」元素；所有占位文案统一。

### Phase 6 — 设置页与帮助（1–2 天）
- SettingsView：General（主题/密度真实）、Shortcuts（真实只读）、Models/Tools/Permissions/About（占位）。
- 帮助弹窗（快捷键表）。
- 验收：设置项变更即时生效并持久化。

### Phase 7 — 收尾（1–2 天）
- 可访问性全面检查（键盘、ARIA、对比度）。
- 组件单测补齐；截图回归。
- 更新 README 与本文档的「已实现」标记。

总量估计：约 12–18 个工作日（不含后端流式与 diff 依赖项）。

---

## 12. 文件变更清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| docs/UI-REDESIGN.md | 新增 | 本文档 |
| src/styles/tokens.css | 新增 | 全量 token |
| src/styles/base.css、layout.css、components.css、chat.css、panels.css | 新增 | 样式拆分 |
| src/app/App.tsx、routes.tsx | 新增/改造 | 路由化 |
| src/layout/AppShell.tsx 等 6 个 | 新增 | 壳层 |
| src/components/ui/* | 新增 | 基础组件 |
| src/config/features.ts、shortcuts.ts、commands.ts、navigation.ts | 新增 | 配置 |
| src/stores/ui.ts、toast.ts | 新增 | 状态 |
| src/features/chat/Composer.tsx 等 | 新增/迁移 | 对话区 |
| src/features/sessions/SessionList.tsx、SessionListItem.tsx | 新增 | 替代 Sidebar 内联 |
| src/features/plan/PlanPanel.tsx | 新增 | 接线 PlanView |
| src/features/artifacts/ArtifactsView.tsx | 新增 | 占位 |
| src/features/settings/SettingsView.tsx | 新增 | 设置 |
| src/components/Icons/Icons.tsx | 改造 | 补图标 |
| src/components/MainLayout.tsx、TopBar/、Sidebar/SessionItem.tsx | 删除或废弃 | 被 AppShell 取代 |
| src/components/Chat/MessageBubble.tsx、ToolCallCard.tsx | 删除或保留为历史 | Turn 化后未用 |
| src/styles.css | 拆分后删除或保留兼容 | 迁移期并存 |

---

## 13. 验收与测试策略

**手动验收清单（每次阶段结束）**
- 1440 / 1920 / 1024 三档截图，无错位/遮挡/横向滚动。
- 深色/浅色切换后所有 surface 与文字对比正常，无「暗底黑字」。
- 键盘走查：Tab 顺序合理，focus-visible 可见，Esc 关闭浮层。
- 占位走查：所有 ComingSoon 入口点击有 Toast。
- 会话闭环：新建 → 发消息 → 看到 Turn → 折叠/展开 → 中断 → 切换 → 删除。

**自动化**
- 单测（vitest + @testing-library/react）：Button/IconButton/Tooltip/EmptyState/Skeleton/ComingSoon、turn-grouping、SessionList 分组逻辑。
- 现有测试（ApprovalDialog/PlanView）保持通过。
- 可选：Playwright 截图回归（后续）。
- CI：pnpm typecheck && lint && test。

---

## 14. 风险与开放问题

**风险**
1. **目录大迁移的回归风险**：建议分两批搬迁，期间新旧并存，最后删除；每批都跑通现有测试。
2. **占位过多的观感风险**：占位必须克制且有明确说明，避免用户误以为产品残缺；优先级上先把「已有后端」的功能接通。
3. **流式缺失影响体感**：没有逐字输出时，长回答等待感强。缓解：Turn 内先显示 Thinking/Running 状态点与耗时，并加「正在生成」占位块；根治需后端 llm_delta。
4. **事件 schema 扩展**：新增事件（llm_delta 等）需同步 core 类型、WS 协议与前端映射表（§9），注意向后兼容。

**开放问题（需产品/后端确认）**
1. 是否引入 llm_delta 事件以支持逐字流式？事件粒度（按 token / 按段落）？
2. Diff 与文件树的数据来源：是否有 checkpoint/文件内容 API，还是只回放事件？
3. 会话重命名/置顶/归档是否需要后端字段（当前 Session 无 pinned/archived）？
4. 多租户/管理端是否要在本期 Web 暴露（/admin 接口已存在）？
5. 是否允许用户自定义主题/密度，还是仅浅深两套？
6. Artifacts 的准确定义（产物文件？生成图片？代码 diff？）决定该模块的真实形态。

---

## 附录 A：图标清单

现有 18 个：Sun、Moon、Cog、ArrowRightOnRectangle、ChatBubble、Sparkles、ArrowUp、WrenchScrewdriver、Clock、Check、XMark、ChevronRight、Plus、CircleEmpty、CircleHalf、CircleFilled、CircleDashed（另有 Logo）。

建议新增（约 30 个）：

| 图标 | 用途 |
| --- | --- |
| SearchIcon | 会话搜索、命令面板 |
| PanelLeftIcon / PanelRightIcon | 侧栏/面板开关 |
| ChevronDownIcon / ChevronLeftIcon | 下拉、折叠、返回 |
| EllipsisHorizontalIcon | 更多菜单 |
| PencilIcon / TrashIcon / PinIcon / ArchiveBoxIcon | 会话重命名/删除/置顶/归档 |
| FolderIcon / DocumentIcon / DocumentDuplicateIcon | 文件、产物 |
| TerminalIcon | 终端面板 |
| CodeBracketIcon | Diff / 代码 |
| GitBranchIcon | 分支 / 工作区 |
| PaperClipIcon / MicrophoneIcon | 附件、语音 |
| StopIcon / PlayIcon / ArrowPathIcon | 停止、运行、重试 |
| ClipboardIcon | 复制 |
| ArrowDownTrayIcon / ArrowUpTrayIcon | 导出、导入 |
| BellIcon | 通知 |
| QuestionMarkCircleIcon | 帮助 |
| CommandIcon | 命令面板（⌘） |
| BoltIcon / ScaleIcon / ChartBarIcon | 成本、用量 |
| ShieldCheckIcon / KeyIcon / ServerStackIcon | 权限、密钥、MCP |
| GlobeAltIcon | 浏览器/网页 |
| UserCircleIcon / UsersIcon | 账号、团队 |
| CpuChipIcon | 模型 |
| FunnelIcon / ArrowsUpDownIcon | 筛选、排序 |
| ExclamationTriangleIcon / InformationCircleIcon / CheckCircleIcon | 状态提示 |
| BrainIcon | 思考/记忆（与 Sparkles 二选一） |
| ListBulletIcon / SquaresIcon | 任务、Tabs |
| ExternalLinkIcon | 外链 |
| ArrowUturnLeftIcon / ArrowUturnRightIcon | 撤销/重做 |

## 附录 B：Token 全表

完整清单见 §8（色彩、字体、间距、圆角、阴影、动效、状态）。落地时 tokens.css 需同时提供 [data-theme="dark"] 覆盖，并保留现有变量名（--bg-primary/--bg-secondary/--bg-tertiary/--accent/--text-primary 等）作为过渡别名，避免一次性改动全部组件。

## 附录 C：参考链接

- OpenHands Agent Canvas：https://docs.openhands.dev/openhands/usage/agent-canvas/overview
- Cursor Design Mode：https://prod.cursor.com/cn/blog/design-mode
- Claude Code WebUI（社区实现，参考会话/工具展示）：https://github.com/EdanStarfire/claudecode_webui
- Codex 主题设计手册（surface/语义色/海拔经验）：https://github.com/codexthemes/skills/blob/main/skills/codex-theme-creator/references/design-playbook.md
- 现有对话区方案：docs/CHAT-DISPLAY-REDESIGN.md
