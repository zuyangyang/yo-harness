# Chat Display Redesign

## Problem

当前 Web UI 的对话展示是事件流的 1:1 平铺映射：每个 `EventEnvelope` 直接对应一个 `MessageBubble`。导致：

- **工具调用、推理文本、最终结果混在一起**，没有视觉层次
- `tool_result` 完全隐藏（返回 `null`），用户看不到工具执行结果
- `tool_call` 和 `tool_result` 没有关联，无法折叠
- 22 种事件类型中只有 5 种可见，其余（plan、checkpoint、memory 等）全部隐藏
- 没有流式文本支持，用户等待时看不到任何进度

参考产品：Cursor（tool call 折叠 + 内联结果）、Claude Desktop（thinking 折叠 + 工具步骤分组）、ChatGPT（tool use 卡片 + 结果内联）、Windsurf（agent steps 时间线）。

## Design Principles

1. **Turn 为基本单元** — 一次用户输入产生的所有 agent 动作（推理、工具调用、结果、最终回复）属于同一个 turn，视觉上归组
2. **层次分明** — 用户消息 > 最终回复 > 推理过程 > 工具调用 > 工具结果，逐层降级视觉权重
3. **可折叠** — 工具调用和推理过程默认折叠，点击展开查看详情
4. **渐进披露** — 默认只看结论，需要时展开过程

## Turn Grouping Model

```
Session
├── Turn 1 (user: "帮我调研 tubi")
│   ├── assistant_text (thinking): "我来帮你调研..."
│   ├── tool_call: web_search "Tubi 公司"
│   ├── tool_result: { ok: true, content: "..." }
│   ├── tool_call: web_fetch "https://..."
│   ├── tool_result: { ok: true, content: "..." }
│   └── assistant_text (final): "Tubi 是 Fox 旗下的流媒体..."
│
├── Turn 2 (user: "它的营收如何？")
│   ├── assistant_text (thinking): "让我查一下财务数据..."
│   ├── tool_call: web_search "Tubi revenue 2024"
│   ├── tool_result: { ok: true, content: "..." }
│   └── assistant_text (final): "Tubi 2024 年营收约..."
```

**Turn 边界判定规则：**
- `turn_started` → 新 turn 开始
- `user_input` → 用户消息（turn 的触发点）
- `turn_completed` → turn 结束
- 两个 `user_input` 之间的一切事件属于同一个 turn

## Component Architecture

### 1. `TurnBlock` — Turn 级容器

每个 turn 渲染为一个 `TurnBlock`，包含：

```
┌─ TurnBlock ──────────────────────────────┐
│  [UserMessage]  帮我调研 tubi 这个公司      │
│                                          │
│  [AssistantResponse]                     │
│  ├─ ThinkingSection (collapsible)        │
│  │   "我来帮你调研 Tubi 这家公司..."       │
│  │   ▸ 3 steps · 2 tools · 1.2s          │
│  │                                        │
│  ├─ ToolSteps (collapsible group)        │
│  │   ▸ web_search "Tubi 公司 流媒体"      │
│  │     ↳ ✓ 8 results · 340ms             │
│  │   ▸ web_search "Tubi Fox streaming"   │
│  │     ↳ ✓ 8 results · 280ms             │
│  │   ▸ web_fetch en.wikipedia.org/...    │
│  │     ↳ ✓ 12.4kb · 520ms                │
│  │   ▸ web_fetch corporate.tubitv.com    │
│  │     ↳ ✓ 8.1kb · 410ms                 │
│  │                                        │
│  ─ FinalReply                           │
│      "Tubi 是 Fox Corporation 旗下的..."   │
│                                          │
│  [TurnMeta]  5 steps · 1.2s · 2.4k tokens │
──────────────────────────────────────────┘
```

### 2. `ThinkingSection` — 推理/思考过程

- 默认折叠，显示摘要行（步骤数 + 工具数 + 耗时）
- 展开后显示 `assistant_text` 中的推理文本（Markdown 渲染）
- 视觉样式：浅灰色背景、左边框、斜体或较小字号，与最终回复区分

### 3. `ToolSteps` — 工具调用步骤组

- 默认折叠，显示摘要行（工具调用数量）
- 每个 tool_call + tool_result 配对为一个 `ToolStep`：
  - **Header**：工具图标 + 工具名 + 关键参数摘要
  - **Status badge**：✓ 成功 / ✗ 失败 / ⏳ 进行中
  - **Duration**：执行耗时
  - **展开内容**：完整 args JSON + 工具返回结果（可滚动）
- 审批中的工具调用显示特殊状态（⏳ waiting approval）

### 4. `FinalReply` — 最终回复

- 正常 Markdown 渲染，与当前 `assistant_text` 一致
- 视觉上最突出：白色背景、正常字号、无边框

### 5. `TurnMeta` — Turn 元信息

- 底部小字显示：步骤数、总耗时、token 用量
- 灰色、小字号、右对齐

## Event → Component Mapping

| Event | Current | New |
|---|---|---|
| `user_input` | MessageBubble (user) | TurnBlock > UserMessage |
| `assistant_text` (first in turn) | MessageBubble (assistant) | TurnBlock > ThinkingSection |
| `assistant_text` (last in turn) | MessageBubble (assistant) | TurnBlock > FinalReply |
| `tool_call` | ToolCallCard (standalone) | TurnBlock > ToolSteps > ToolStep |
| `tool_result` | null (hidden) | TurnBlock > ToolSteps > ToolStep (result) |
| `error` | MessageBubble (error) | TurnBlock > ErrorBanner |
| `approval_request` | null | ToolStep status → "waiting approval" |
| `turn_started` | null | TurnBlock boundary marker |
| `turn_completed` | null | TurnBlock > TurnMeta (usage stats) |
| All others | null | null (unchanged) |

**判定 assistant_text 是 thinking 还是 final reply 的规则：**
- turn 内最后一个 `assistant_text`（在 `turn_completed` 之前）→ FinalReply
- turn 内其他 `assistant_text` → ThinkingSection
- 如果 turn 内只有一个 `assistant_text` 且没有 tool_call → 直接作为 FinalReply（无 thinking 区块）

## Streaming Behavior

当前 web UI 不支持流式显示。改进方案：

1. **Thinking 流式** — `llm_delta` 事件通过 WebSocket 推送，ThinkingSection 实时追加文本
2. **Tool 状态流式** — tool_call 出现时立即显示 ToolStep（状态 ⏳），tool_result 到达时更新为 ✓/✗ + 耗时
3. **FinalReply 流式** — 最后一个 assistant_text 流式输出

实现方式：WebSocket `event` 消息到达时，`addEvent` 更新 store，TurnBlock 根据最新事件实时重渲染。

## Visual Design

```css
/* TurnBlock */
.turn-block { margin-bottom: 24px; }

/* UserMessage */
.turn-user { text-align: right; margin-bottom: 16px; }
.turn-user .bubble { background: var(--color-primary); color: #fff; }

/* ThinkingSection */
.turn-thinking {
  background: var(--color-surface-2);
  border-left: 3px solid var(--color-border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 12px;
  font-size: 14px;
  color: var(--color-text-secondary);
}
.turn-thinking__summary {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ToolSteps */
.turn-tools {
  background: var(--color-surface-2);
  border-radius: 8px;
  margin-bottom: 12px;
  overflow: hidden;
}
.turn-tools__summary {
  padding: 10px 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.tool-step {
  border-top: 1px solid var(--color-border);
  padding: 10px 16px;
}
.tool-step__header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-family: var(--font-mono);
}
.tool-step__status { font-size: 12px; }
.tool-step__status--success { color: var(--color-success); }
.tool-step__status--error { color: var(--color-error); }
.tool-step__status--pending { color: var(--color-warning); }
.tool-step__result {
  margin-top: 8px;
  padding: 8px;
  background: var(--color-surface-3);
  border-radius: 4px;
  font-size: 12px;
  font-family: var(--font-mono);
  max-height: 200px;
  overflow-y: auto;
}

/* FinalReply */
.turn-reply {
  font-size: 15px;
  line-height: 1.7;
}

/* TurnMeta */
.turn-meta {
  font-size: 12px;
  color: var(--color-text-tertiary);
  text-align: right;
  margin-top: 8px;
}
```

## Implementation Plan

### Step 1: Turn grouping utility
- 新建 `packages/web/src/utils/turn-grouping.ts`
- 输入：`EventEnvelope[]`（按 seq 排序）
- 输出：`Turn[]`，每个 Turn 包含 `userMessage`、`events`、`thinkingTexts`、`toolCalls`、`toolResults`、`finalText`、`usage`

### Step 2: ThinkingSection component
- 新建 `packages/web/src/components/Chat/ThinkingSection.tsx`
- 可折叠，显示推理文本 + 摘要

### Step 3: ToolSteps component
- 新建 `packages/web/src/components/Chat/ToolSteps.tsx`
- 可折叠，包含多个 ToolStep
- 每个 ToolStep 配对 tool_call + tool_result

### Step 4: TurnBlock component
- 新建 `packages/web/src/components/Chat/TurnBlock.tsx`
- 组合 UserMessage + ThinkingSection + ToolSteps + FinalReply + TurnMeta

### Step 5: ChatArea 改造
- 用 TurnBlock 替代当前的 1:1 MessageBubble 映射
- 保留 MessageBubble 用于 standalone 场景（如 error）

### Step 6: Streaming support
- WebSocket event 到达时实时更新当前 turn 的显示
- tool_call 出现 → 立即渲染 ToolStep（pending 状态）
- tool_result 到达 → 更新 ToolStep 状态和结果
- assistant_text delta → 追加到 ThinkingSection 或 FinalReply

## Files Changed

| File | Action |
|---|---|
| `packages/web/src/utils/turn-grouping.ts` | New |
| `packages/web/src/components/Chat/TurnBlock.tsx` | New |
| `packages/web/src/components/Chat/ThinkingSection.tsx` | New |
| `packages/web/src/components/Chat/ToolSteps.tsx` | New |
| `packages/web/src/components/Chat/ChatArea.tsx` | Modify |
| `packages/web/src/components/Chat/MessageBubble.tsx` | Keep (error fallback) |
| `packages/web/src/components/Chat/ToolCallCard.tsx` | Deprecate (replaced by ToolSteps) |
| `packages/web/src/styles.css` | Add turn/tool styles |
