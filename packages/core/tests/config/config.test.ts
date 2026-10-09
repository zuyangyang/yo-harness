import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activeApiKey, loadConfig } from '../../src/config/config.js';
import { DEFAULT_BUDGET_LIMITS } from '../../src/core/budget.js';
import { FatalError } from '../../src/types/errors.js';

const NO_ENV: Record<string, string | undefined> = {};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yo-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(json: unknown): string {
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, typeof json === 'string' ? json : JSON.stringify(json));
  return configPath;
}

/** 指向不存在的文件 = 无配置文件场景 */
function missingPath(): string {
  return join(dir, 'does-not-exist.json');
}

describe('loadConfig', () => {
  it('无配置文件、无覆盖 → 全部内置默认', () => {
    const config = loadConfig({ configPath: missingPath(), env: NO_ENV });

    expect(config.defaultProvider).toBe('anthropic');
    expect(config.providers.anthropic).toEqual({
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      model: 'claude-sonnet-4-5',
      contextWindow: 200_000,
    });
    expect(config.providers['openai-compat']).toEqual({
      apiKeyEnv: 'OPENAI_COMPAT_API_KEY',
      model: 'deepseek-chat',
      contextWindow: 128_000,
    });
    expect(config.search).toBeUndefined();
    expect(config.permission).toEqual({ shellMode: 'ask', shellAllowlist: [] });
    expect(config.budget).toEqual(DEFAULT_BUDGET_LIMITS);
  });

  it('完整配置文件各段生效（含 baseURL 与 search 透传）', () => {
    const configPath = writeConfig({
      defaultProvider: 'openai-compat',
      providers: {
        anthropic: { model: 'claude-opus-4', contextWindow: 150_000 },
        'openai-compat': {
          baseURL: 'https://api.deepseek.com/v1',
          apiKeyEnv: 'DEEPSEEK_KEY',
          model: 'deepseek-reasoner',
          contextWindow: 96_000,
        },
      },
      search: { provider: 'bocha', apiKeyEnv: 'MY_BOCHA_KEY' },
      permission: { shellMode: 'allowlist', shellAllowlist: ['npm test', 'git status'] },
      budget: { maxStepsPerTurn: 8, maxTokensPerTurn: 1000, maxTurnDurationMs: 20_000 },
    });

    const config = loadConfig({ configPath, env: NO_ENV });

    expect(config.defaultProvider).toBe('openai-compat');
    expect(config.providers['openai-compat']).toEqual({
      apiKeyEnv: 'DEEPSEEK_KEY',
      model: 'deepseek-reasoner',
      contextWindow: 96_000,
      baseURL: 'https://api.deepseek.com/v1',
    });
    // 文件未覆盖的 provider 保持默认（apiKeyEnv 未写 → 默认变量名）
    expect(config.providers.anthropic).toEqual({
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      model: 'claude-opus-4',
      contextWindow: 150_000,
    });
    expect(config.search).toEqual({ provider: 'bocha', apiKeyEnv: 'MY_BOCHA_KEY' });
    expect(config.permission).toEqual({ shellMode: 'allowlist', shellAllowlist: ['npm test', 'git status'] });
    expect(config.budget).toEqual({ maxStepsPerTurn: 8, maxTokensPerTurn: 1000, maxTurnDurationMs: 20_000 });
  });

  it('budget 允许部分覆盖，未写字段回默认', () => {
    const configPath = writeConfig({ budget: { maxStepsPerTurn: 5 } });
    const config = loadConfig({ configPath, env: NO_ENV });

    expect(config.budget).toEqual({
      maxStepsPerTurn: 5,
      maxTokensPerTurn: DEFAULT_BUDGET_LIMITS.maxTokensPerTurn,
      maxTurnDurationMs: DEFAULT_BUDGET_LIMITS.maxTurnDurationMs,
    });
  });

  it('pricing 段解析为用户价格覆盖表', () => {
    const configPath = writeConfig({
      pricing: {
        'wlyd/deepseek-v4-pro': { inputPerMillion: 0.5, outputPerMillion: 2 },
        'deepseek-flash': {
          inputPerMillion: 0.1,
          outputPerMillion: 0.4,
          cachedInputPerMillion: 0.02,
        },
      },
    });
    const config = loadConfig({ configPath, env: NO_ENV });

    expect(config.pricing).toEqual({
      'wlyd/deepseek-v4-pro': { inputPerMillion: 0.5, outputPerMillion: 2 },
      'deepseek-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4, cachedInputPerMillion: 0.02 },
    });
  });

  it('无 pricing 段时 pricing 为 undefined（调用方回落内置表）', () => {
    const configPath = writeConfig({ budget: { maxStepsPerTurn: 5 } });
    expect(loadConfig({ configPath, env: NO_ENV }).pricing).toBeUndefined();
  });

  it('provider 优先级：flag > env > 文件', () => {
    const configPath = writeConfig({
      defaultProvider: 'anthropic',
      providers: { anthropic: { model: 'file-m' }, 'openai-compat': { model: 'file-o' } },
    });

    expect(loadConfig({ configPath, env: NO_ENV }).defaultProvider).toBe('anthropic');
    expect(loadConfig({ configPath, env: { YO_PROVIDER: 'openai-compat' } }).defaultProvider).toBe(
      'openai-compat',
    );
    expect(
      loadConfig({
        configPath,
        env: { YO_PROVIDER: 'openai-compat' },
        flagProvider: 'anthropic',
      }).defaultProvider,
    ).toBe('anthropic');
  });

  it('model 优先级只作用于生效 provider，另一个不受 flag 污染', () => {
    const configPath = writeConfig({
      defaultProvider: 'anthropic',
      providers: { anthropic: { model: 'file-m' }, 'openai-compat': { model: 'file-o' } },
    });

    // 无覆盖 → 文件 model
    expect(loadConfig({ configPath, env: NO_ENV }).providers.anthropic.model).toBe('file-m');
    // env 覆盖生效 provider
    expect(loadConfig({ configPath, env: { YO_MODEL: 'env-m' } }).providers.anthropic.model).toBe('env-m');
    // flag 最高
    const flagged = loadConfig({
      configPath,
      env: { YO_MODEL: 'env-m' },
      flagModel: 'flag-m',
    });
    expect(flagged.providers.anthropic.model).toBe('flag-m');
    // 未生效的 provider 保持文件里的 model
    expect(flagged.providers['openai-compat'].model).toBe('file-o');
  });

  it('空白的环境变量值视为未设置，回退文件值', () => {
    const configPath = writeConfig({ defaultProvider: 'openai-compat' });
    const config = loadConfig({ configPath, env: { YO_PROVIDER: '   ' } });

    expect(config.defaultProvider).toBe('openai-compat');
  });

  it('yolo flag 覆盖文件 shellMode；文件自身也允许 yolo', () => {
    const configPath = writeConfig({ permission: { shellMode: 'ask' } });

    expect(loadConfig({ configPath, env: NO_ENV }).permission.shellMode).toBe('ask');
    expect(loadConfig({ configPath, env: NO_ENV, yolo: true }).permission.shellMode).toBe('yolo');

    const yoloPath = writeConfig({ permission: { shellMode: 'yolo' } });
    expect(loadConfig({ configPath: yoloPath, env: NO_ENV }).permission.shellMode).toBe('yolo');
  });

  it('未知 provider（flag / env 来源）→ FatalError 并给出设置指引', () => {
    expect(() => loadConfig({ configPath: missingPath(), env: NO_ENV, flagProvider: 'nope' })).toThrow(
      /unknown provider "nope".*--provider/s,
    );
    expect(() => loadConfig({ configPath: missingPath(), env: { YO_PROVIDER: 'nope' } })).toThrow(
      FatalError,
    );
  });

  it('配置文件不是合法 JSON → FatalError 提示修复或删除', () => {
    const configPath = writeConfig('{oops');
    expect(() => loadConfig({ configPath, env: NO_ENV })).toThrow(/not valid JSON.*fix the JSON syntax/s);
  });

  it('schema 校验失败：未知键 / 非法枚举 / 非正整数，均列出字段路径', () => {
    const typoPath = writeConfig({ defaultProvidr: 'anthropic' });
    expect(() => loadConfig({ configPath: typoPath, env: NO_ENV })).toThrow(/defaultProvidr/);

    const enumPath = writeConfig({ search: { provider: 'google' } });
    expect(() => loadConfig({ configPath: enumPath, env: NO_ENV })).toThrow(/search\.provider/);

    const budgetPath = writeConfig({ budget: { maxStepsPerTurn: -1 } });
    expect(() => loadConfig({ configPath: budgetPath, env: NO_ENV })).toThrow(/maxStepsPerTurn/);
  });
});

describe('activeApiKey', () => {
  it('从生效 provider 的环境变量名取 key；缺失或空白返回 undefined', () => {
    const config = loadConfig({ configPath: missingPath(), env: NO_ENV });

    expect(activeApiKey(config, { ANTHROPIC_API_KEY: 'sk-x' })).toBe('sk-x');
    expect(activeApiKey(config, NO_ENV)).toBeUndefined();
    expect(activeApiKey(config, { ANTHROPIC_API_KEY: '   ' })).toBeUndefined();
  });
});
