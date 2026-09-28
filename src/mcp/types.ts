/**
 * MCP 协议类型定义。
 *
 * 覆盖 JSON-RPC 2.0 基础类型 + MCP initialize / tools/list / tools/call
 * 请求响应结构。Phase 3 仅实现 stdio 传输（本地 MCP server 子进程通信）。
 */

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 通知（无 id，无响应） */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** MCP initialize 结果 */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: { tools?: Record<string, unknown> };
  serverInfo: { name: string; version: string };
}

/** MCP 工具定义（tools/list 返回） */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tools/list 结果 */
export interface McpListToolsResult {
  tools: McpToolDefinition[];
}

/** MCP 工具调用结果 */
export interface McpCallResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** 单个 MCP server 的配置 */
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  startupTimeoutMs?: number;
}
