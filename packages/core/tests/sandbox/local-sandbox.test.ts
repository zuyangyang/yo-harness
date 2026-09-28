/**
 * createLocalSandbox 单元测试。
 *
 * 覆盖：exec（stdout/stderr、超时、输出截断）、
 * readFile / writeFile / listDir、生命周期。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalSandbox } from '../../src/sandbox/local-sandbox.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'yo-sandbox-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('createLocalSandbox', () => {
  describe('exec', () => {
    it('捕获 stdout 和 stderr', async () => {
      const sandbox = createLocalSandbox(ws);
      const result = await sandbox.exec('echo hello && echo err >&2');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
      expect(result.stderr.trim()).toBe('err');
      expect(result.timedOut).toBe(false);
    });

    it('非零退出码不抛异常', async () => {
      const sandbox = createLocalSandbox(ws);
      const result = await sandbox.exec('exit 42');
      expect(result.exitCode).toBe(42);
      expect(result.timedOut).toBe(false);
    });

    it('超时后 killed 并标记 timedOut', async () => {
      const sandbox = createLocalSandbox(ws);
      const started = Date.now();
      const result = await sandbox.exec('sleep 60', { timeoutMs: 200 });
      const elapsed = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(5000);
    });

    it('stdout 超过 cap 时截断并标记 stdoutTruncated', async () => {
      const sandbox = createLocalSandbox(ws);
      const result = await sandbox.exec(
        'node -e "process.stdout.write(\'x\'.repeat(30000))"',
        { maxOutputBytes: 1024 },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdoutTruncated).toBe(true);
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
    });

    it('未截断时 stdoutTruncated 为 false', async () => {
      const sandbox = createLocalSandbox(ws);
      const result = await sandbox.exec('echo hi');
      expect(result.stdoutTruncated).toBe(false);
    });

    it('cwd 选项相对于沙箱 cwd 解析', async () => {
      const sub = path.join(ws, 'sub');
      mkdirSync(sub);
      const sandbox = createLocalSandbox(ws);
      const result = await sandbox.exec('pwd', { cwd: 'sub' });
      expect(result.stdout.trim()).toMatch(/sub$/);
    });
  });

  describe('文件操作', () => {
    it('writeFile + readFile 往返', async () => {
      const sandbox = createLocalSandbox(ws);
      await sandbox.writeFile('hello.txt', 'world');
      const buf = await sandbox.readFile('hello.txt');
      expect(buf.toString('utf8')).toBe('world');
    });

    it('writeFile 自动创建父目录', async () => {
      const sandbox = createLocalSandbox(ws);
      await sandbox.writeFile('a/b/c.txt', 'deep');
      const buf = await sandbox.readFile('a/b/c.txt');
      expect(buf.toString('utf8')).toBe('deep');
    });

    it('readFile 读已存在文件', async () => {
      writeFileSync(path.join(ws, 'existing.txt'), 'pre-existing');
      const sandbox = createLocalSandbox(ws);
      const buf = await sandbox.readFile('existing.txt');
      expect(buf.toString('utf8')).toBe('pre-existing');
    });

    it('listDir 返回目录内容', async () => {
      writeFileSync(path.join(ws, 'a.txt'), '');
      mkdirSync(path.join(ws, 'subdir'));
      const sandbox = createLocalSandbox(ws);
      const entries = await sandbox.listDir('.');
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['a.txt', 'subdir']);
    });
  });

  describe('生命周期', () => {
    it('初始状态 ready，destroy 后 stopped', async () => {
      const sandbox = createLocalSandbox(ws);
      expect(sandbox.getStatus()).toBe('ready');
      await sandbox.destroy();
      expect(sandbox.getStatus()).toBe('stopped');
    });
  });
});
