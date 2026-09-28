import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { resolveInWorkspace, yoHome } from '../../src/utils/paths.js';

function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'yo-paths-'));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('errorMessage', () => {
  it('Error 取 message，其余 String 化', async () => {
    const { errorMessage } = await import('../../src/utils/errors.js');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ x: 1 })).toBe('[object Object]');
  });
});

describe('yoHome', () => {
  it('默认 ~/.yo-harness，YO_DATA_DIR 可覆盖', () => {
    vi.stubEnv('YO_DATA_DIR', '/tmp/yo-alt');
    expect(yoHome()).toBe('/tmp/yo-alt');

    vi.stubEnv('YO_DATA_DIR', undefined);
    expect(yoHome()).toBe(path.join(homedir(), '.yo-harness'));
  });
});

describe('resolveInWorkspace', () => {
  it('相对路径以 cwd 为基准解析为绝对路径', () => {
    const ws = makeWorkspace();
    try {
      expect(resolveInWorkspace(ws, 'a/b.txt')).toBe(path.join(ws, 'a', 'b.txt'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('cwd 内的绝对路径放行', () => {
    const ws = makeWorkspace();
    try {
      const abs = path.join(ws, 'notes.md');
      writeFileSync(abs, 'x');
      expect(resolveInWorkspace(ws, abs)).toBe(abs);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('.. 穿越（直接与间接）拒绝', () => {
    const ws = makeWorkspace();
    try {
      expect(() => resolveInWorkspace(ws, '../secret')).toThrow(/escapes the session workspace/);
      expect(() => resolveInWorkspace(ws, 'a/../../escape')).toThrow(
        /escapes the session workspace/,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('cwd 外的绝对路径拒绝', () => {
    const ws = makeWorkspace();
    try {
      expect(() => resolveInWorkspace(ws, '/etc/passwd')).toThrow(
        /escapes the session workspace/,
      );
      expect(() => resolveInWorkspace(ws, path.join(tmpdir(), 'outside.txt'))).toThrow(
        /escapes the session workspace/,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('兄弟目录前缀（/ws-evil vs /ws）不算 cwd 内', () => {
    const ws = makeWorkspace();
    try {
      expect(() => resolveInWorkspace(ws, `${ws}-evil/x`)).toThrow(
        /escapes the session workspace/,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('cwd 本身与 ".." 开头的普通文件名放行', () => {
    const ws = makeWorkspace();
    try {
      expect(resolveInWorkspace(ws, '.')).toBe(ws);
      expect(resolveInWorkspace(ws, '..hidden')).toBe(path.join(ws, '..hidden'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
