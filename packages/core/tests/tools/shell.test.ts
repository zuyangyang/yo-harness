import { describe, expect, it } from 'vitest';

import { MAX_TIMEOUT_MS, shellTool } from '../../src/tools/shell.js';
import { cleanupWorkspace, makeCtx, makeWorkspace } from './helpers.js';

describe('shell', () => {
  it('捕获 stdout 与退出码 0', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run(
        { command: 'node -e "console.log(\'hi from shell\')"' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(true);
      expect(res.content).toMatch(/exit code: 0/);
      expect(res.content).toContain('hi from shell');
      expect(res.content).toContain('--- stderr ---');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('在会话 cwd 执行', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run(
        { command: 'node -e "console.log(process.cwd())"' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(true);
      expect(res.content).toContain(ws);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('非零退出码 → ok=false 且带退出码', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run(
        { command: 'node -e "process.exit(3)"' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/exit code: 3/);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('stderr 单独成段', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run(
        { command: 'node -e "console.error(\'boom-err\')"' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(true);
      expect(res.content).toMatch(/--- stderr ---\nboom-err/);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('真 shell 语义：管道与 && 可用', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run(
        { command: 'echo alpha && echo beta | tr a-z A-Z' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(true);
      expect(res.content).toContain('alpha');
      expect(res.content).toContain('BETA');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('超时：默认/自定义 timeoutMs 触发进程组击杀，快速返回', async () => {
    const ws = makeWorkspace();
    try {
      const started = Date.now();
      const res = await shellTool.run(
        { command: 'node -e "setTimeout(() => {}, 60000)"', timeoutMs: 300 },
        makeCtx(ws),
      );
      const elapsed = Date.now() - started;
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/timed out after 300ms \(killed\)/);
      expect(elapsed).toBeLessThan(5_000); // 真的被杀掉了，而不是等满 60s
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('stdout 截断到 10KB 并提示', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run(
        { command: 'node -e "process.stdout.write(\'x\'.repeat(30000))"' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(true);
      expect(res.content).toContain('[stdout truncated at 10KB]');
      expect(res.content).not.toContain('x'.repeat(10 * 1024 + 1));
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('stdin 被忽略：读 stdin 的命令立即得到 EOF', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run(
        { command: 'node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>console.log(\'EOF:\'+s.length))"' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(true);
      expect(res.content).toContain('EOF:0');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('timeoutMs 超上限被 zod 拒绝', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run(
        { command: 'echo hi', timeoutMs: MAX_TIMEOUT_MS + 1 },
        makeCtx(ws),
      );
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/invalid arguments for shell/);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('命令为空被 zod 拒绝', async () => {
    const ws = makeWorkspace();
    try {
      const res = await shellTool.run({ command: '' }, makeCtx(ws));
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/invalid arguments for shell/);
    } finally {
      cleanupWorkspace(ws);
    }
  });
});
