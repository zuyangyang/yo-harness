/**
 * 工具模型：注册表里每个工具的契约。
 *
 * 四要素：name / description / risk / inputSchema。
 * run() 永不 throw —— 失败也是 ToolResult(ok=false)。
 * description 是给模型看的 API 文档，质量直接决定选工具正确率。
 */
import type { z } from 'zod';
import type { Logger } from './common.js';
import type { SandboxProvider } from './sandbox.js';

export type RiskLevel = 'read' | 'write' | 'net' | 'danger';

export interface ToolResult {
  ok: boolean;
  /** 给模型看的文本（失败时为人类可读的错误说明与修复提示） */
  content: string;
  /** 结构化数据（渲染层 / 后续版本预留） */
  data?: unknown;
  /** Phase 4: 结构化错误分类（loop 优先据此决定重试，取代子串嗅探） */
  errorKind?: 'transient' | 'permanent' | 'usage';
}

export interface ExecutionContext {
  sessionId: string;
  /** 会话工作目录，所有相对路径以此为基准 */
  cwd: string;
  logger: Logger;
  /** Phase 4：沙箱提供者（由 agent-loop 注入） */
  sandbox: SandboxProvider;
  /**
   * Phase 2：写操作前快照回调（由 agent-loop 注入）。
   * 写入文件前调用，返回 checkpointId；为 undefined 时跳过快照（测试 / 无检查点场景）。
   */
  snapshotBeforeWrite?: (relPath: string) => Promise<string>;
  /** 当前事件 seq（供快照使用） */
  currentSeq?: number;
}

export interface Tool {
  /** snake_case */
  readonly name: string;
  /** 英文：一句话作用 + 何时用 + 参数语义 + 典型错误 */
  readonly description: string;
  readonly risk: RiskLevel;
  /**
   * 工具输入 schema。内置工具用 zod（运行时校验），MCP 工具用 JSON Schema 对象
   * （服务端校验，客户端跳过 parse）。registry.specs() 根据类型分支处理。
   */
  readonly inputSchema: z.ZodType<Record<string, unknown>> | Record<string, unknown>;
  run(args: unknown, ctx: ExecutionContext): Promise<ToolResult>;
}

/** 提供给 LLM 的工具规格（inputSchema 为 JSON Schema 对象） */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
