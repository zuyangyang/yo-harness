import { describe, expect, it } from 'vitest';
import type { ChatResponse } from '../../src/types/llm.js';
import type { ModelRoleMap } from '../../src/types/router.js';
import { LLMGateway } from '../../src/llm/gateway.js';
import { ModelRouter } from '../../src/router/model-router.js';

function fakeClient(name: string) {
  return {
    name,
    model: 'test-model',
    chat: (): Promise<ChatResponse> =>
      Promise.resolve({
        text: 'ok',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
  };
}

function makeGateway(clients: [string, ReturnType<typeof fakeClient>][]): LLMGateway {
  return new LLMGateway(new Map(clients), { defaultProvider: clients[0]![0] });
}

describe('ModelRouter', () => {
  it('未配置角色时回退默认 client', () => {
    const anthropic = fakeClient('anthropic');
    const gateway = makeGateway([['anthropic', anthropic]]);
    const router = new ModelRouter(gateway, {});

    expect(router.getClient('main')).toBe(anthropic);
    expect(router.getClient('compressor')).toBe(anthropic);
  });

  it('按角色返回指定 provider 的 client', () => {
    const anthropic = fakeClient('anthropic');
    const openai = fakeClient('openai-compat');
    const gateway = makeGateway([
      ['anthropic', anthropic],
      ['openai-compat', openai],
    ]);
    const roles: ModelRoleMap = {
      compressor: { provider: 'openai-compat', model: 'deepseek-chat' },
    };
    const router = new ModelRouter(gateway, roles);

    expect(router.getClient('compressor')).toBe(openai);
    expect(router.getClient('main')).toBe(anthropic);
  });

  it('未知 provider 抛错', () => {
    const gateway = makeGateway([['anthropic', fakeClient('anthropic')]]);
    expect(
      () =>
        new ModelRouter(gateway, {
          main: { provider: 'nonexistent', model: 'x' },
        }),
    ).toThrow(/provider 'nonexistent' not found/);
  });

  it('listRoles 列出已配置的角色', () => {
    const anthropic = fakeClient('anthropic');
    const openai = fakeClient('openai-compat');
    const gateway = makeGateway([
      ['anthropic', anthropic],
      ['openai-compat', openai],
    ]);
    const roles: ModelRoleMap = {
      main: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      compressor: { provider: 'openai-compat', model: 'deepseek-chat' },
    };
    const router = new ModelRouter(gateway, roles);

    const list = router.listRoles();
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.role === 'main')?.provider).toBe('anthropic');
    expect(list.find((r) => r.role === 'compressor')?.provider).toBe('openai-compat');
  });

  it('getProvider 返回角色对应的 provider 名', () => {
    const anthropic = fakeClient('anthropic');
    const openai = fakeClient('openai-compat');
    const gateway = makeGateway([
      ['anthropic', anthropic],
      ['openai-compat', openai],
    ]);
    const roles: ModelRoleMap = {
      extractor: { provider: 'openai-compat', model: 'deepseek-chat' },
    };
    const router = new ModelRouter(gateway, roles);

    expect(router.getProvider('extractor')).toBe('openai-compat');
    expect(router.getProvider('main')).toBe('anthropic');
  });
});
