import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createInteractivePermission,
  createNonInteractivePermission,
  matchesAllowlist,
  summarizeToolCall,
} from '../../src/core/permission.js';
import type { ApprovalAnswer, ApprovalAsk, ApprovalRequest } from '../../src/core/permission.js';
import type { Tool } from '../../src/types/tools.js';

// ---------------------------------------------------------------------------
// 测试设施
// ---------------------------------------------------------------------------

const stubRun = () => Promise.resolve({ ok: true, content: '' });

const readTool: Tool = {
  name: 'read_file',
  description: 'stub',
  risk: 'read',
  inputSchema: z.object({ path: z.string() }),
  run: stubRun,
};

const writeTool: Tool = {
  name: 'write_file',
  description: 'stub',
  risk: 'write',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  run: stubRun,
};

const anotherWriteTool: Tool = {
  name: 'write_config',
  description: 'stub',
  risk: 'write',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  run: stubRun,
};

const shellTool: Tool = {
  name: 'shell',
  description: 'stub',
  risk: 'danger',
  inputSchema: z.object({ command: z.string() }),
  run: stubRun,
};

const netTool: Tool = {
  name: 'web_search',
  description: 'stub',
  risk: 'net',
  inputSchema: z.object({ query: z.string() }),
  run: stubRun,
};

/** 记录每次询问的假 asker */
function recordingAsk(answer: ApprovalAnswer): { ask: ApprovalAsk; requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  const ask: ApprovalAsk = (request) => {
    requests.push(request);
    return Promise.resolve(answer);
  };
  return { ask, requests };
}

const ARGS = { path: 'a.txt', content: 'x', command: 'npm test', query: 'q' };
const CALL_ID = 'call-1';

// ---------------------------------------------------------------------------
// matchesAllowlist
// ---------------------------------------------------------------------------

describe('matchesAllowlist', () => {
  const allowlist = ['npm test', 'git status'];

  it('字面量与整词前缀命中', () => {
    expect(matchesAllowlist('npm test', allowlist)).toBe(true);
    expect(matchesAllowlist('npm test -- --watch=false', allowlist)).toBe(true);
    expect(matchesAllowlist('git status', allowlist)).toBe(true);
  });

  it('非整词前缀 / 其他命令 / 空条目不命中', () => {
    expect(matchesAllowlist('npm testx', allowlist)).toBe(false);
    expect(matchesAllowlist('npm', allowlist)).toBe(false);
    expect(matchesAllowlist('rm -rf /', allowlist)).toBe(false);
    expect(matchesAllowlist('npm test', [''])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// summarizeToolCall（脱敏）
// ---------------------------------------------------------------------------

describe('summarizeToolCall', () => {
  it('write_file：只报路径与字符数，绝不包含内容', () => {
    const summary = summarizeToolCall('write_file', {
      path: 'src/config.ts',
      content: 'const apiKey = "sk-secret-do-not-leak";',
    });
    expect(summary).toBe('write_file src/config.ts (39 chars)');
    expect(summary).not.toContain('sk-secret');
  });

  it('shell：展示命令，超 200 字符截断', () => {
    expect(summarizeToolCall('shell', { command: 'npm run build' })).toBe('npm run build');
    const long = summarizeToolCall('shell', { command: 'x'.repeat(300) });
    expect(long.length).toBeLessThanOrEqual(201);
    expect(long.endsWith('…')).toBe(true);
    expect(long.startsWith('xxxx')).toBe(true);
  });

  it('其他工具：参数名 + 截断值预览', () => {
    const summary = summarizeToolCall('read_file', { path: 'a/b/c.txt' });
    expect(summary).toBe('read_file path=a/b/c.txt');
    const long = summarizeToolCall('web_fetch', {
      url: `https://example.com/${'y'.repeat(100)}`,
    });
    expect(long).toContain('url=https://example.com/');
    expect(long.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createInteractivePermission：风险矩阵
// ---------------------------------------------------------------------------

describe('createInteractivePermission', () => {
  it('read / net → 自动放行，不询问', async () => {
    const { ask, requests } = recordingAsk('yes');
    const pm = createInteractivePermission(ask);

    const read = await pm.request(readTool, ARGS, CALL_ID);
    const net = await pm.request(netTool, ARGS, CALL_ID);
    expect(read).toEqual({ approved: true, scope: 'once' });
    expect(net).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(0);
  });

  it('write → 询问：yes 放行一次', async () => {
    const { ask, requests } = recordingAsk('yes');
    const pm = createInteractivePermission(ask);

    const decision = await pm.request(writeTool, ARGS, CALL_ID);
    expect(decision).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.toolName).toBe('write_file');
    expect(requests[0]?.callId).toBe(CALL_ID);
    expect(requests[0]?.summary).toBe('write_file a.txt (1 chars)');
  });

  it('write → 询问：no 拒绝', async () => {
    const { ask } = recordingAsk('no');
    const pm = createInteractivePermission(ask);
    const decision = await pm.request(writeTool, ARGS, CALL_ID);
    expect(decision).toEqual({ approved: false, scope: 'once' });
  });

  it('write → always：本会话同名工具放行，其他 write 工具仍询问', async () => {
    const { ask, requests } = recordingAsk('always');
    const pm = createInteractivePermission(ask);

    const first = await pm.request(writeTool, ARGS, CALL_ID);
    expect(first).toEqual({ approved: true, scope: 'session' });

    // 同名工具不再询问
    const second = await pm.request(writeTool, ARGS, 'call-2');
    expect(second).toEqual({ approved: true, scope: 'session' });
    expect(requests).toHaveLength(1);

    // 其他 write 工具不受影响
    const other = await pm.request(anotherWriteTool, ARGS, 'call-3');
    expect(other).toEqual({ approved: true, scope: 'session' });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.toolName).toBe('write_config');
  });

  it('mode=auto：白名单命中自动放行，未命中的 danger 仍询问', async () => {
    const { ask, requests } = recordingAsk('yes');
    const pm = createInteractivePermission(
      ask,
      { mode: 'auto', shellMode: 'ask', shellAllowlist: ['npm test'] },
    );

    // ARGS.command = 'npm test' 命中白名单
    const allowed = await pm.request(shellTool, ARGS, 'call-1');
    expect(allowed).toEqual({ approved: true, scope: 'once' });

    const other = await pm.request(shellTool, { command: 'rm -rf /' }, 'call-2');
    expect(other).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(1);
    expect(pm.getMode()).toBe('auto');
  });

  it('setMode：运行期切换到 full 后全量放行', async () => {
    const { ask, requests } = recordingAsk('no');
    const pm = createInteractivePermission(ask, { shellMode: 'ask', shellAllowlist: [] });

    pm.setMode('full');
    expect(pm.getMode()).toBe('full');
    const decision = await pm.request(writeTool, ARGS, CALL_ID);
    expect(decision).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(0);
  });

  it('danger + shellMode=ask → 每次都询问（yes 后下次仍询问）', async () => {
    const { ask, requests } = recordingAsk('yes');
    const pm = createInteractivePermission(ask, { shellMode: 'ask', shellAllowlist: [] });

    const d1 = await pm.request(shellTool, ARGS, 'call-1');
    const d2 = await pm.request(shellTool, ARGS, 'call-2');
    expect(d1).toEqual({ approved: true, scope: 'once' });
    expect(d2).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(2);
  });

  it('danger + shellMode=ask → always 不做会话级放行（仍按 once 处理）', async () => {
    const { ask, requests } = recordingAsk('always');
    const pm = createInteractivePermission(ask, { shellMode: 'ask', shellAllowlist: [] });

    const d1 = await pm.request(shellTool, ARGS, 'call-1');
    const d2 = await pm.request(shellTool, ARGS, 'call-2');
    expect(d1).toEqual({ approved: true, scope: 'once' });
    expect(d2).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(2);
  });

  it('danger + shellMode=allowlist：命中放行，未命中询问', async () => {
    const { ask, requests } = recordingAsk('no');
    const pm = createInteractivePermission(ask, {
      shellMode: 'allowlist',
      shellAllowlist: ['npm test', 'git status'],
    });

    const allowed = await pm.request(shellTool, { command: 'npm test -- --coverage' }, CALL_ID);
    expect(allowed).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(0);

    const asked = await pm.request(shellTool, { command: 'rm -rf /tmp/x' }, 'call-2');
    expect(asked).toEqual({ approved: false, scope: 'once' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.summary).toBe('rm -rf /tmp/x');
  });

  it('shellMode=yolo → 全放行（含 write 与 danger），不询问', async () => {
    const { ask, requests } = recordingAsk('no');
    const pm = createInteractivePermission(ask, { shellMode: 'yolo', shellAllowlist: [] });

    expect(await pm.request(writeTool, ARGS, CALL_ID)).toEqual({ approved: true, scope: 'once' });
    expect(await pm.request(shellTool, ARGS, 'call-2')).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(0);
  });

  it('write 在非 yolo 模式下不受 allowlist 影响（仍询问）', async () => {
    const { ask, requests } = recordingAsk('yes');
    const pm = createInteractivePermission(ask, {
      shellMode: 'allowlist',
      shellAllowlist: ['npm test'],
    });
    const decision = await pm.request(writeTool, ARGS, CALL_ID);
    expect(decision).toEqual({ approved: true, scope: 'once' });
    expect(requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createNonInteractivePermission（-p 模式）
// ---------------------------------------------------------------------------

describe('createNonInteractivePermission', () => {
  it('默认（ask）：read/net 放行，write/danger 拒绝', async () => {
    const pm = createNonInteractivePermission();
    expect(await pm.request(readTool, ARGS, CALL_ID)).toEqual({ approved: true, scope: 'once' });
    expect(await pm.request(netTool, ARGS, 'call-2')).toEqual({ approved: true, scope: 'once' });
    expect(await pm.request(writeTool, ARGS, 'call-3')).toEqual({ approved: false, scope: 'once' });
    expect(await pm.request(shellTool, ARGS, 'call-4')).toEqual({ approved: false, scope: 'once' });
  });

  it('allowlist：命中放行，未命中拒绝', async () => {
    const pm = createNonInteractivePermission({
      shellMode: 'allowlist',
      shellAllowlist: ['npm test'],
    });
    expect(await pm.request(shellTool, { command: 'npm test' }, CALL_ID)).toEqual({
      approved: true,
      scope: 'once',
    });
    expect(await pm.request(shellTool, { command: 'curl evil' }, 'call-2')).toEqual({
      approved: false,
      scope: 'once',
    });
    // write 仍拒绝（allowlist 只作用于 danger）
    expect(await pm.request(writeTool, ARGS, 'call-3')).toEqual({
      approved: false,
      scope: 'once',
    });
  });

  it('yolo：全部放行', async () => {
    const pm = createNonInteractivePermission({ shellMode: 'yolo', shellAllowlist: [] });
    expect(await pm.request(readTool, ARGS, CALL_ID)).toEqual({ approved: true, scope: 'once' });
    expect(await pm.request(writeTool, ARGS, 'call-2')).toEqual({ approved: true, scope: 'once' });
    expect(await pm.request(shellTool, ARGS, 'call-3')).toEqual({ approved: true, scope: 'once' });
  });
});
