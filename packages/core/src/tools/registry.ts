/**
 * 工具注册表。
 *
 * Agent loop 只面对本注册表与 types/tools.ts 的 Tool 接口，不感知
 * fs / shell / web 具体工具的存在（测试与后续 MCP 化可整体替换注册内容）。
 * specs() 把 zod schema 转成 JSON Schema 供 Provider 下发：
 * Anthropic 与 OpenAI 兼容接口要的都是 JSON Schema。
 *
 * Phase 3 扩展：支持 MCP 工具的 JSON Schema 直传 + 动态 unregister。
 */
import { z } from 'zod';
import type { Tool, ToolSpec } from '../types/tools.js';
import { listDirTool, readFileTool, writeFileTool } from './fs.js';
import { shellTool } from './shell.js';
import { createWebFetchTool, createWebSearchTool } from './web.js';
import type { WebSearchSettings } from './web.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** 重名注册视为装配期错误，直接抛出 */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 移除单个工具（MCP server 关闭时调用） */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 按名前缀批量移除（清理某个 MCP server 的全部工具） */
  unregisterByPrefix(prefix: string): number {
    let count = 0;
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        count++;
      }
    }
    return count;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 注册顺序即列表顺序 */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * 提供给 LLM 的工具规格。
   * 内置工具（zod schema）走 zod→JSON Schema 转换；
   * MCP 工具（已是 JSON Schema 对象）直传。
   */
  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: isZodSchema(tool.inputSchema)
        ? zodToJsonSchema(tool.inputSchema)
        : tool.inputSchema,
    }));
  }
}

function isZodSchema(
  schema: z.ZodType<Record<string, unknown>> | Record<string, unknown>,
): schema is z.ZodType<Record<string, unknown>> {
  return schema instanceof z.ZodType;
}

/** $schema 是 JSON Schema 的自述装饰键，Provider 不需要，剥掉 */
function zodToJsonSchema(schema: z.ZodType<Record<string, unknown>>): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export interface BuiltinRegistryOptions {
  /**
   * web_search 的 provider 配置（来自 ~/.yo-harness/config.json 的 search 字段）。
   * 缺省时工具照常注册，运行时返回配置指引而非静默缺失。
   */
  search?: WebSearchSettings;
}

/** 注册 Phase 1 冻结的 6 个内置工具 */
export function createBuiltinRegistry(options: BuiltinRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listDirTool);
  registry.register(shellTool);
  registry.register(createWebFetchTool());
  registry.register(createWebSearchTool(options.search));
  return registry;
}
