/**
 * MCP 工具适配器：把 MCP server 暴露的工具转换成内部 Tool 接口。
 *
 * 命名约定：`{serverName}__{toolName}`（双下划线分隔，避免与内置工具
 * snake_case 命名冲突；server 前缀保证跨 server 唯一性）。
 *
 * 风险等级统一标 net（MCP 工具默认走外部进程，按网络调用对待，
 * 触发审批流程）；inputSchema 直传 MCP server 提供的 JSON Schema
 * （registry.specs() 对非 zod schema 直接透传给 Provider）。
 *
 * run() 永不 throw：MCP server 报错也包成 ToolResult.ok=false +
 * [TRANSIENT] 前缀，让 agent-loop 当作普通工具失败处理（可重试）。
 */
import type { McpClient } from './client.js';
import type { McpToolDefinition } from './types.js';
import type { ExecutionContext, Tool, ToolResult } from '../types/tools.js';

export const MCP_ERROR_TRANSIENT = '[TRANSIENT]';

export interface CreateMcpToolInput {
  serverName: string;
  definition: McpToolDefinition;
  client: McpClient;
}

export function createMcpTool(input: CreateMcpToolInput): Tool {
  const { serverName, definition, client } = input;
  const name = `${serverName}__${definition.name}`;
  const description = definition.description ?? `(MCP tool from ${serverName})`;
  const inputSchema = definition.inputSchema;

  return {
    name,
    description,
    risk: 'net',
    inputSchema,
    async run(args: unknown, ctx: ExecutionContext): Promise<ToolResult> {
      const callArgs = (args ?? {}) as Record<string, unknown>;
      try {
        const result = await client.callTool(definition.name, callArgs);
        const text = result.content
          .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
          .filter((s) => s.length > 0)
          .join('\n');
        if (result.isError === true) {
          return { ok: false, content: `${MCP_ERROR_TRANSIENT} ${serverName}/${definition.name}: ${text || '(no message)'}` };
        }
        return { ok: true, content: text || '(empty)' };
      } catch (err) {
        ctx.logger.warn('mcp tool call failed', { tool: name, error: String(err) });
        return { ok: false, content: `${MCP_ERROR_TRANSIENT} ${serverName}/${definition.name}: ${String(err)}` };
      }
    },
  };
}
