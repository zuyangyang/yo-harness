/**
 * MCP 管理器：并行启动所有配置的 MCP server，把每个 server 暴露的工具
 * 通过 adapter 注册到 ToolRegistry。
 *
 * 启动语义：
 * - startAll() 用 Promise.allSettled 并行启动，单个 server 失败不拖垮其他；
 * - 失败的 server 记录到 failures 列表（带 serverName + error message），
 *   由 CLI 层决定是否渲染到状态栏；
 * - 成功的 server 的每个工具通过 createMcpTool 包装后注册到 registry，
 *   并在内部 clients map 里保留 client 引用（stopAll 关闭用）。
 *
 * 关闭语义：stopAll() 串行关闭所有活跃 client（避免并行关闭时子进程
 * stdout/stderr 交错输出），然后清空内部状态；已注册的 MCP 工具由调用方
 * 通过 registry.unregisterByPrefix 批量移除（manager 不直接依赖 registry
 * 的清理逻辑，保持单向依赖）。
 */
import type { Logger } from '../types/common.js';
import type { ToolRegistry } from '../tools/registry.js';
import { McpClient } from './client.js';
import { createMcpTool } from './adapter.js';
import type { McpServerConfig } from './types.js';

export interface McpManagerFailure {
  serverName: string;
  error: string;
}

export interface McpManagerDeps {
  servers: Record<string, McpServerConfig>;
  registry: ToolRegistry;
  logger: Logger;
}

export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly failures: McpManagerFailure[] = [];
  private readonly servers: Record<string, McpServerConfig>;
  private readonly registry: ToolRegistry;
  private readonly logger: Logger;

  constructor(deps: McpManagerDeps) {
    this.servers = deps.servers;
    this.registry = deps.registry;
    this.logger = deps.logger;
  }

  /** 并行启动全部 server；失败项收集到 failures，不抛出 */
  async startAll(): Promise<void> {
    const entries = Object.entries(this.servers);
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(async ([serverName, config]) => {
        const client = new McpClient(serverName, config, this.logger);
        await client.start();
        return { serverName, client };
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const entry = entries[i];
      if (result === undefined || entry === undefined) continue;
      const serverName = entry[0];
      if (result.status === 'fulfilled') {
        const { client } = result.value;
        this.clients.set(serverName, client);
        try {
          const tools = await client.listTools();
          for (const def of tools) {
            const tool = createMcpTool({ serverName, definition: def, client });
            try {
              this.registry.register(tool);
            } catch (err) {
              this.logger.warn('mcp tool registration skipped', {
                server: serverName,
                tool: def.name,
                error: String(err),
              });
            }
          }
          this.logger.info('mcp server ready', { server: serverName, tools: tools.length });
        } catch (err) {
          this.failures.push({ serverName, error: `listTools failed: ${String(err)}` });
          this.clients.delete(serverName);
          await client.stop().catch(() => undefined);
        }
      } else {
        this.failures.push({ serverName, error: String(result.reason) });
        this.logger.warn('mcp server start failed', { server: serverName, error: String(result.reason) });
      }
    }
  }

  /** 串行关闭全部活跃 client */
  async stopAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.stop();
      } catch (err) {
        this.logger.warn('mcp client stop failed', { server: name, error: String(err) });
      }
    }
    this.clients.clear();
  }

  get startedServers(): string[] {
    return [...this.clients.keys()];
  }

  get registeredToolCount(): number {
    let count = 0;
    for (const prefix of this.clients.keys()) {
      count += this.registry.names().filter((n) => n.startsWith(`${prefix}__`)).length;
    }
    return count;
  }

  /** 启动失败列表（只读快照） */
  get failed(): readonly McpManagerFailure[] {
    return this.failures;
  }

  /** 是否有任一 server 成功启动 */
  get hasActive(): boolean {
    return this.clients.size > 0;
  }
}
