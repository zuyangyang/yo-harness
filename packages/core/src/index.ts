/**
 * @yo-harness/core 公共 API 入口（barrel）。
 *
 * 内核采用端口-适配器架构，本文件聚合对外暴露的稳定模块，供
 * `import { ... } from '@yo-harness/core'` 使用。
 *
 * 注意：CLI / Server 内部装配通常走 `@yo-harness/core/<area>/<module>.js`
 * 子路径（package.json 的 "./*" 通配导出），根入口只作为公共 API 兜底。
 * 命名冲突由 TypeScript 的 `export *` 语义静默消解（后导出的同名符号优先）。
 */
export * from './config/config.js';

export * from './core/agent-loop.js';
export * from './core/budget.js';
export * from './core/checkpoint.js';
export * from './core/compressor.js';
export * from './core/context-manager.js';
export * from './core/event-bus.js';
export * from './core/goal-tracker.js';
export * from './core/permission.js';
export * from './core/planner.js';
export * from './core/ports.js';
export * from './core/summarizer.js';

export * from './daemon/daemon-api.js';
export * from './daemon/daemon-main.js';
export * from './daemon/task-runner.js';
export * from './daemon/types.js';

export * from './llm/gateway.js';
export * from './llm/provider-errors.js';
export * from './llm/model-catalog.js';
export * from './llm/providers/anthropic.js';
export * from './llm/providers/fake.js';
export * from './llm/providers/openai-compat.js';
export * from './llm/providers/tool-args.js';

export * from './mcp/adapter.js';
export * from './mcp/client.js';
export * from './mcp/manager.js';
export * from './mcp/transport.js';
export * from './mcp/types.js';

export * from './memory/extractor.js';
export * from './memory/injector.js';

export * from './router/cost-tracker.js';
export * from './router/model-router.js';

export * from './sandbox/local-sandbox.js';

export * from './storage/checkpoint-store.js';
export * from './storage/db.js';
export * from './storage/event-store.js';
export * from './storage/memory-store.js';
export * from './storage/session-store.js';
export * from './storage/task-store.js';
export * from './storage/workspace-store.js';

export * from './tools/fs.js';
export * from './tools/registry.js';
export * from './tools/shell.js';
export * from './tools/web.js';

export * from './types/common.js';
export * from './types/errors.js';
export * from './types/events.js';
export * from './types/llm.js';
export * from './types/memory.js';
export * from './types/model-config.js';
export * from './types/plan.js';
export * from './types/router.js';
export * from './types/sandbox.js';
export * from './types/tools.js';

// `StopReason` 在 types/errors.js（预算熔断原因）与 types/llm.js（LLM 停止原因）
// 中同名但语义不同，`export *` 会产生歧义。此处显式重导出以消解，保留 LLM 语义。
export type { StopReason } from './types/llm.js';

export * from './utils/errors.js';
export * from './utils/logger.js';
export * from './utils/paths.js';
export * from './utils/title.js';
export * from './utils/tokens.js';
