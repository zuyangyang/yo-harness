import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createBuiltinRegistry, ToolRegistry } from '../../src/tools/registry.js';
import type { Tool } from '../../src/types/tools.js';
import { cleanupWorkspace, makeCtx, makeWorkspace } from './helpers.js';

const asRecord = (value: unknown): Record<string, unknown> =>
  (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;

const echoTool: Tool = {
  name: 'echo',
  description: 'Returns its JSON-serialized input unchanged.',
  risk: 'read',
  inputSchema: z.object({ text: z.string() }),
  run: (args) => Promise.resolve({ ok: true, content: JSON.stringify(args) }),
};

const BUILTIN_NAMES = [
  'read_file',
  'write_file',
  'list_dir',
  'shell',
  'web_fetch',
  'web_search',
];

describe('ToolRegistry', () => {
  it('注册 / 获取 / 列举自定义工具', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(registry.get('echo')).toBe(echoTool);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.names()).toEqual(['echo']);
    expect(registry.list()).toEqual([echoTool]);
  });

  it('重复注册同名工具 → 装配期抛错', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow(/duplicate tool registration: echo/);
  });

  it('specs()：zod → JSON Schema，剥 $schema，整体可序列化', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const specs = registry.specs();

    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(spec?.name).toBe('echo');
    expect(spec?.description).toContain('Returns');
    const schema = asRecord(spec?.inputSchema);
    expect(schema.type).toBe('object');
    expect(schema.$schema).toBeUndefined();
    expect(schema.required).toEqual(['text']);
    expect(asRecord(asRecord(schema.properties).text).type).toBe('string');
    // Provider 侧会整体 JSON.stringify 下发
    expect(JSON.parse(JSON.stringify(specs))).toEqual(specs);
  });
});

describe('createBuiltinRegistry', () => {
  it('注册冻结的 6 个内置工具（注册顺序）', () => {
    const registry = createBuiltinRegistry();
    expect(registry.names()).toEqual(BUILTIN_NAMES);
  });

  it('specs()：每个工具都有 object 形态 schema 与非空 description', () => {
    const registry = createBuiltinRegistry();
    const specs = registry.specs();
    expect(specs.map((s) => s.name)).toEqual(BUILTIN_NAMES);

    for (const spec of specs) {
      expect(spec.description.length, spec.name).toBeGreaterThan(0);
      const schema = asRecord(spec.inputSchema);
      expect(schema.type, spec.name).toBe('object');
      expect(schema.$schema, spec.name).toBeUndefined();
      expect(Object.keys(asRecord(schema.properties)).length, spec.name).toBeGreaterThan(0);
    }
    // 全量可 JSON 序列化（无 undefined / symbol 泄漏）
    expect(JSON.parse(JSON.stringify(specs))).toEqual(specs);
  });

  it('specs() 细节：read_file 必填 path；shell 的 timeoutMs 可选', () => {
    const registry = createBuiltinRegistry();
    const specs = registry.specs();

    const readFile = specs.find((s) => s.name === 'read_file');
    expect(asRecord(readFile?.inputSchema).required).toEqual(['path']);

    const shell = specs.find((s) => s.name === 'shell');
    const shellSchema = asRecord(shell?.inputSchema);
    expect(asRecord(asRecord(shellSchema.properties).command).type).toBe('string');
    expect(asRecord(shellSchema.required)).not.toContain('timeoutMs');
  });

  it('经注册表调用内置工具：read_file 端到端', async () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'note.txt'), 'hello registry');
      const registry = createBuiltinRegistry();

      const tool = registry.get('read_file');
      expect(tool).toBeDefined();
      const res = await tool?.run({ path: 'note.txt' }, makeCtx(ws));
      expect(res?.ok).toBe(true);
      expect(res?.content).toBe('hello registry');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('未配置 search：web_search 仍注册，运行返回配置指引', async () => {
    const registry = createBuiltinRegistry();
    const res = await registry.get('web_search')?.run({ query: 'x' }, makeCtx('/tmp'));
    expect(res?.ok).toBe(false);
    expect(res?.content).toMatch(/web_search is not configured/);
  });

  it('传入 search 配置 → 带给 web_search（缺 key 时提示具体变量名）', async () => {
    // 用肯定不存在的变量名，避免测试机上恰好导出了 key 导致真实外访
    const registry = createBuiltinRegistry({
      search: { provider: 'tavily', apiKeyEnv: 'YO_TEST_ABSENT_KEY' },
    });
    const res = await registry.get('web_search')?.run({ query: 'x' }, makeCtx('/tmp'));
    expect(res?.ok).toBe(false);
    expect(res?.content).toMatch(/YO_TEST_ABSENT_KEY/);
  });
});

describe('ToolRegistry Phase 3 扩展', () => {
  it('unregister 移除已注册工具', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(registry.unregister('echo')).toBe(true);
    expect(registry.get('echo')).toBeUndefined();
    expect(registry.unregister('echo')).toBe(false);
  });

  it('unregisterByPrefix 按前缀批量移除', () => {
    const registry = new ToolRegistry();
    const mcpToolA: Tool = {
      ...echoTool,
      name: 'mcp_server_a__read',
    };
    const mcpToolB: Tool = {
      ...echoTool,
      name: 'mcp_server_a__write',
    };
    const otherTool: Tool = {
      ...echoTool,
      name: 'other_tool',
    };
    registry.register(mcpToolA);
    registry.register(mcpToolB);
    registry.register(otherTool);

    const removed = registry.unregisterByPrefix('mcp_server_a__');
    expect(removed).toBe(2);
    expect(registry.names()).toEqual(['other_tool']);
  });

  it('specs() 对 JSON Schema 对象直传、不经过 zod 转换', () => {
    const registry = new ToolRegistry();
    const jsonSchemaTool: Tool = {
      name: 'mcp_remote_tool',
      description: 'A tool from MCP server',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      run: () => Promise.resolve({ ok: true, content: 'done' }),
    };
    registry.register(jsonSchemaTool);

    const specs = registry.specs();
    expect(specs).toHaveLength(1);
    const schema = specs[0]!.inputSchema;
    expect(schema.type).toBe('object');
    expect(schema).toHaveProperty('properties.query');
    // 不应有 zod 转换产生的 $schema
    expect(schema.$schema).toBeUndefined();
  });

  it('specs("compact")：裁掉子结构只留 type 与顶层属性名', () => {
    const registry = new ToolRegistry();
    const richTool: Tool = {
      name: 'rich',
      description: 'A tool with nested schema',
      risk: 'read',
      inputSchema: z.object({
        city: z.string().describe('city name'),
        options: z.object({ unit: z.enum(['c', 'f']) }).optional(),
      }),
      run: () => Promise.resolve({ ok: true, content: 'done' }),
    };
    registry.register(richTool);

    const full = registry.specs('full')[0]!;
    const fullSchema = asRecord(full.inputSchema);
    expect(asRecord(asRecord(fullSchema.properties).options).type).toBe('object');

    const compact = registry.specs('compact')[0]!;
    const compactSchema = asRecord(compact.inputSchema);
    expect(compactSchema.type).toBe('object');
    expect(compactSchema.properties).toEqual({ city: {}, options: {} });
    // 子结构 / 枚举 / 字段描述都被裁掉
    expect(JSON.stringify(compactSchema)).not.toContain('enum');
    expect(JSON.stringify(compactSchema)).not.toContain('description');
  });
});
