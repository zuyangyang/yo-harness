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

// 必须在 vi.mock 之后 import
const { StdioTransport } = await import('../../src/mcp/transport.js');

describe('StdioTransport', () => {
  beforeEach(() => {
    mockProc = createMockProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('request 发 JSON-RPC → 收到正确响应 → resolve', async () => {
    const transport = new StdioTransport(SIMPLE_CONFIG, SILENT_LOGGER);
    transport.start();

    const requestPromise = transport.request('test/method', { foo: 'bar' });

    let writtenData = '';
    mockProc.stdin.on('data', (chunk: Buffer) => {
      writtenData += chunk.toString();
    });

    await new Promise((r) => setTimeout(r, 10));

    const request = JSON.parse(writtenData.trim());
    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('test/method');
    expect(request.params).toEqual({ foo: 'bar' });
    expect(typeof request.id).toBe('number');

    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { success: true },
    });
    mockProc.stdout.write(response + '\n');

    const result = await requestPromise;
    expect(result).toEqual({ success: true });

    await transport.stop();
  });

  it('超时 → reject', async () => {
    const transport = new StdioTransport(SIMPLE_CONFIG, SILENT_LOGGER);
    transport.start();

    await expect(transport.request('test/method', {}, 50)).rejects.toThrow('timed out');

    await transport.stop();
  });

  it('子进程异常退出 → pending requests 全部 reject', async () => {
    const transport = new StdioTransport(SIMPLE_CONFIG, SILENT_LOGGER);
    transport.start();

    const requestPromise = transport.request('test/method', {}, 5000);

    mockProc.exitCode = 1;
    mockProc.emit('exit', 1, null);

    await expect(requestPromise).rejects.toThrow('MCP process exited');

    await transport.stop();
  });

  it('stdout 多行消息正确分割', async () => {
    const transport = new StdioTransport(SIMPLE_CONFIG, SILENT_LOGGER);
    transport.start();

    const promise1 = transport.request('method1', {}, 5000);
    const promise2 = transport.request('method2', {}, 5000);

    await new Promise((r) => setTimeout(r, 10));

    const responses = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { r: 1 } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { r: 2 } }),
    ].join('\n') + '\n';

    mockProc.stdout.write(responses);

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toEqual({ r: 1 });
    expect(result2).toEqual({ r: 2 });

    await transport.stop();
  });

  it('error 响应 → reject with error message', async () => {
    const transport = new StdioTransport(SIMPLE_CONFIG, SILENT_LOGGER);
    transport.start();

    const requestPromise = transport.request('test/method', {}, 5000);

    await new Promise((r) => setTimeout(r, 10));

    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid Request' },
    });
    mockProc.stdout.write(response + '\n');

    await expect(requestPromise).rejects.toThrow('MCP error -32600: Invalid Request');

    await transport.stop();
  });

  it('alive 状态正确反映', async () => {
    const transport = new StdioTransport(SIMPLE_CONFIG, SILENT_LOGGER);

    expect(transport.alive).toBe(false);

    transport.start();
    expect(transport.alive).toBe(true);

    await transport.stop();
    expect(transport.alive).toBe(false);
  });
});
