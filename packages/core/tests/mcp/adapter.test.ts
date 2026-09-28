import { describe, expect, it, vi } from 'vitest';

import { createMcpTool, MCP_ERROR_TRANSIENT } from '../../src/mcp/adapter.js';
import type { McpClient } from '../../src/mcp/client.js';
import type { McpToolDefinition } from '../../src/mcp/types.js';
import type { ExecutionContext } from '../../src/types/tools.js';

function makeClient(overrides: Partial<Pick<McpClient, 'callTool'>> = {}): McpClient {
  return {
    callTool: vi.fn(() => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] })),
    ...overrides,
  } as unknown as McpClient;
}

function makeCtx(): ExecutionContext {
  return {
    sessionId: 'test-session',
    cwd: '/tmp',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

const definition: McpToolDefinition = {
  name: 'read_file',
  description: 'Read a file from the filesystem',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

describe('createMcpTool', () => {
  it('name 含 server 前缀（双下划线分隔）', () => {
    const tool = createMcpTool({ serverName: 'fs', definition, client: makeClient() });
    expect(tool.name).toBe('fs__read_file');
  });

  it('risk 标为 net', () => {
    const tool = createMcpTool({ serverName: 'fs', definition, client: makeClient() });
    expect(tool.risk).toBe('net');
  });

  it('inputSchema 直传 MCP server 提供的 JSON Schema', () => {
    const tool = createMcpTool({ serverName: 'fs', definition, client: makeClient() });
    expect(tool.inputSchema).toEqual(definition.inputSchema);
  });

  it('run 调 client.callTool 并返回 ToolResult.ok=true', async () => {
    const callTool = vi.fn(() => Promise.resolve({
      content: [{ type: 'text', text: 'file contents' }],
    }));
    const tool = createMcpTool({
      serverName: 'fs',
      definition,
      client: makeClient({ callTool }),
    });
    const result = await tool.run({ path: '/etc/hosts' }, makeCtx());
    expect(result.ok).toBe(true);
    expect(result.content).toBe('file contents');
    expect(callTool).toHaveBeenCalledWith('read_file', { path: '/etc/hosts' });
  });

  it('MCP server 返回 isError → ToolResult.ok=false + [TRANSIENT] 标记', async () => {
    const callTool = vi.fn(() => Promise.resolve({
      content: [{ type: 'text', text: 'permission denied' }],
      isError: true,
    }));
    const tool = createMcpTool({
      serverName: 'fs',
      definition,
      client: makeClient({ callTool }),
    });
    const result = await tool.run({ path: '/root/secret' }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain(MCP_ERROR_TRANSIENT);
    expect(result.content).toContain('fs/read_file');
    expect(result.content).toContain('permission denied');
  });

  it('callTool throw → ToolResult.ok=false + [TRANSIENT] 标记', async () => {
    const callTool = vi.fn(() => Promise.reject(new Error('process exited')));
    const tool = createMcpTool({
      serverName: 'fs',
      definition,
      client: makeClient({ callTool }),
    });
    const result = await tool.run({ path: '/x' }, makeCtx());
    expect(result.ok).toBe(false);
    expect(result.content).toContain(MCP_ERROR_TRANSIENT);
    expect(result.content).toContain('process exited');
  });

  it('description 缺失时用默认文案', () => {
    const noDesc: McpToolDefinition = { name: 'foo', inputSchema: {} };
    const tool = createMcpTool({ serverName: 'srv', definition: noDesc, client: makeClient() });
    expect(tool.description).toContain('MCP tool from srv');
  });

  it('content 多条 text 块拼接', async () => {
    const callTool = vi.fn(() => Promise.resolve({
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
        { type: 'image', data: 'xxx' },
      ],
    }));
    const tool = createMcpTool({
      serverName: 'srv',
      definition,
      client: makeClient({ callTool }),
    });
    const result = await tool.run({}, makeCtx());
    expect(result.content).toBe('line1\nline2');
  });
});
