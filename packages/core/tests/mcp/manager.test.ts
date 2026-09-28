import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../src/types/common.js';
import type { McpServerConfig } from '../../src/mcp/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { McpManager } from '../../src/mcp/manager.js';

vi.mock('../../src/mcp/client.js', () => {
  const instances: MockClientInstance[] = [];
  const configs = new Map<string, (m: MockClientInstance) => void>();
  class MockMcpClient {
    readonly serverName: string;
    startCalls = 0;
    stopCalls = 0;
    startError: Error | null = null;
    listToolsResult: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];
    listToolsError: Error | null = null;

    constructor(serverName: string) {
      this.serverName = serverName;
      const configFn = configs.get(serverName);
      if (configFn !== undefined) configFn(this);
      instances.push(this);
    }
    start(): void {
      this.startCalls += 1;
      if (this.startError !== null) throw this.startError;
    }
    listTools() {
      if (this.listToolsError !== null) throw this.listToolsError;
      return this.listToolsResult;
    }
    callTool(_name: string, _args: Record<string, unknown>) {
      return { content: [{ type: 'text', text: 'ok' }] };
    }
    stop(): Promise<void> {
      this.stopCalls += 1;
      return Promise.resolve();
    }
  }
  return {
    McpClient: MockMcpClient,
    __instances: instances,
    __configure: (serverName: string, setup: (m: MockClientInstance) => void) => {
      configs.set(serverName, setup);
    },
    __reset: () => {
      instances.length = 0;
      configs.clear();
    },
  };
});

interface MockClientInstance {
  serverName: string;
  startCalls: number;
  stopCalls: number;
  startError: Error | null;
  listToolsResult: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  listToolsError: Error | null;
}

const mockModule = await import('../../src/mcp/client.js') as unknown as {
  __instances: MockClientInstance[];
  __configure: (serverName: string, setup: (m: MockClientInstance) => void) => void;
  __reset: () => void;
};

const SILENT_LOGGER: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  mockModule.__reset();
});

afterEach(() => {
  mockModule.__reset();
});

describe('McpManager', () => {
  it('并行启动 2 个 server → 工具全部注册到 registry', async () => {
    const servers: Record<string, McpServerConfig> = {
      fs: { command: 'echo', args: ['fs'] },
      db: { command: 'echo', args: ['db'] },
    };
    const registry = new ToolRegistry();

    mockModule.__configure('fs', (m) => {
      m.listToolsResult = [
        { name: 'read', description: 'read file', inputSchema: {} },
        { name: 'write', description: 'write file', inputSchema: {} },
      ];
    });
    mockModule.__configure('db', (m) => {
      m.listToolsResult = [{ name: 'query', description: 'run sql', inputSchema: {} }];
    });

    const manager = new McpManager({ servers, registry, logger: SILENT_LOGGER });
    await manager.startAll();

    expect(manager.startedServers.sort()).toEqual(['db', 'fs']);
    expect(manager.registeredToolCount).toBe(3);
    expect(manager.failed).toEqual([]);
    expect(manager.hasActive).toBe(true);
  });

  it('1 个 server 启动失败 → 其他正常 → failed 列表包含失败 server', async () => {
    const servers: Record<string, McpServerConfig> = {
      good: { command: 'echo', args: ['good'] },
      bad: { command: 'echo', args: ['bad'] },
    };
    const registry = new ToolRegistry();

    mockModule.__configure('good', (m) => {
      m.listToolsResult = [{ name: 'hello', description: 'greet', inputSchema: {} }];
    });
    mockModule.__configure('bad', (m) => {
      m.startError = new Error('spawn ENOENT');
    });

    const manager = new McpManager({ servers, registry, logger: SILENT_LOGGER });
    await manager.startAll();

    expect(manager.startedServers).toEqual(['good']);
    expect(manager.failed).toHaveLength(1);
    expect(manager.failed[0]?.serverName).toBe('bad');
    expect(manager.failed[0]?.error).toContain('ENOENT');
    expect(manager.registeredToolCount).toBe(1);
  });

  it('listTools 失败 → server 从 active 移除并记入 failed', async () => {
    const servers: Record<string, McpServerConfig> = {
      flaky: { command: 'echo', args: ['flaky'] },
    };
    const registry = new ToolRegistry();

    mockModule.__configure('flaky', (m) => {
      m.listToolsError = new Error('protocol error');
    });

    const manager = new McpManager({ servers, registry, logger: SILENT_LOGGER });
    await manager.startAll();

    expect(manager.startedServers).toEqual([]);
    expect(manager.failed).toHaveLength(1);
    expect(manager.failed[0]?.error).toContain('listTools failed');
  });

  it('stopAll 关闭全部 client', async () => {
    const servers: Record<string, McpServerConfig> = {
      a: { command: 'echo', args: ['a'] },
      b: { command: 'echo', args: ['b'] },
    };
    const registry = new ToolRegistry();

    mockModule.__configure('a', (m) => {
      m.listToolsResult = [];
    });
    mockModule.__configure('b', (m) => {
      m.listToolsResult = [];
    });

    const manager = new McpManager({ servers, registry, logger: SILENT_LOGGER });
    await manager.startAll();
    expect(manager.startedServers.sort()).toEqual(['a', 'b']);

    await manager.stopAll();

    for (const inst of mockModule.__instances) {
      expect(inst.stopCalls).toBe(1);
    }
    expect(manager.startedServers).toEqual([]);
    expect(manager.hasActive).toBe(false);
  });

  it('servers 为空 → startAll 直接返回，无副作用', async () => {
    const registry = new ToolRegistry();
    const manager = new McpManager({ servers: {}, registry, logger: SILENT_LOGGER });
    await manager.startAll();
    expect(manager.startedServers).toEqual([]);
    expect(manager.failed).toEqual([]);
    expect(manager.hasActive).toBe(false);
  });
});
