import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Logger } from '../../src/types/common.js';
import type { McpServerConfig } from '../../src/mcp/types.js';

const SILENT_LOGGER: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const SIMPLE_CONFIG: McpServerConfig = {
  command: 'echo',
  args: ['test'],
};

function createMockProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    kill: (signal?: string) => boolean;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    proc.exitCode = 0;
    proc.emit('exit', 0, null);
    return true;
  });
  return proc;
}

let mockProc: ReturnType<typeof createMockProcess>;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockProc),
}));

const { McpClient } = await import('../../src/mcp/client.js');

describe('McpClient', () => {
  beforeEach(() => {
    mockProc = createMockProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('start() 发 initialize + initialized → listTools 返回工具列表', async () => {
    const client = new McpClient('test-server', SIMPLE_CONFIG, SILENT_LOGGER);

    const startPromise = client.start();

    await new Promise((r) => setTimeout(r, 10));

    mockProc.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'test-server', version: '1.0.0' },
        },
      }) + '\n',
    );

    await startPromise;

    expect(client.name).toBe('test-server');
    expect(client.alive).toBe(true);
    expect(client.info).toEqual({ name: 'test-server', version: '1.0.0' });

    const listPromise = client.listTools();

    await new Promise((r) => setTimeout(r, 10));

    mockProc.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          tools: [
            { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
          ],
        },
      }) + '\n',
    );

    const tools = await listPromise;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('read_file');

    await client.stop();
  });

  it('callTool 发送正确参数并返回结果', async () => {
    const client = new McpClient('test-server', SIMPLE_CONFIG, SILENT_LOGGER);

    const startPromise = client.start();
    await new Promise((r) => setTimeout(r, 10));
    mockProc.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'test-server', version: '1.0.0' },
        },
      }) + '\n',
    );
    await startPromise;

    const callPromise = client.callTool('read_file', { path: '/test.txt' });

    await new Promise((r) => setTimeout(r, 10));

    mockProc.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
        },
      }) + '\n',
    );

    const result = await callPromise;
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.text).toBe('file contents');
    expect(result.isError).toBe(false);

    await client.stop();
  });
});
