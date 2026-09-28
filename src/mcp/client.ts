/**
 * MCP 客户端：在 transport 之上实现 MCP 协议语义。
 *
 * 生命周期：start() → initialized → ready（可调用 tools）→ stop()
 */
import type { Logger } from '../types/common.js';
import { DEFAULT_STARTUP_TIMEOUT_MS } from './transport.js';
import { StdioTransport } from './transport.js';
import type {
  McpCallResult,
  McpInitializeResult,
  McpListToolsResult,
  McpServerConfig,
  McpToolDefinition,
} from './types.js';

export class McpClient {
  private readonly transport: StdioTransport;
  private serverInfo: { name: string; version: string } | null = null;

  constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly logger: Logger,
  ) {
    this.transport = new StdioTransport(config, logger);
  }

  /** 启动 + 握手（initialize + initialized 通知） */
  async start(): Promise<void> {
    await this.transport.start();

    const startupTimeout = this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const result = (await this.transport.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'yo-harness', version: '0.3.0' },
      },
      startupTimeout,
    )) as McpInitializeResult;

    this.serverInfo = result.serverInfo;
    this.transport.notify('notifications/initialized');
  }

  /** 列出 server 提供的工具 */
  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.transport.request('tools/list')) as McpListToolsResult;
    return result.tools;
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return (await this.transport.request('tools/call', { name, arguments: args })) as McpCallResult;
  }

  /** 优雅关闭 */
  async stop(): Promise<void> {
    await this.transport.stop();
  }

  get name(): string {
    return this.serverName;
  }

  get alive(): boolean {
    return this.transport.alive;
  }

  get info(): { name: string; version: string } | null {
    return this.serverInfo;
  }
}
