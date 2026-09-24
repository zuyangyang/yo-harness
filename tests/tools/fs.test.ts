import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { listDirTool, readFileTool, writeFileTool } from '../../src/tools/fs.js';
import { cleanupWorkspace, makeCtx, makeWorkspace } from './helpers.js';

describe('read_file', () => {
  it('读回 write_file 写入的内容', async () => {
    const ws = makeWorkspace();
    try {
      await writeFileTool.run({ path: 'a.txt', content: 'hello 你好' }, makeCtx(ws));
      const res = await readFileTool.run({ path: 'a.txt' }, makeCtx(ws));
      expect(res.ok).toBe(true);
      expect(res.content).toBe('hello 你好');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('文件不存在 → ok=false 且提示 ENOENT', async () => {
    const ws = makeWorkspace();
    try {
      const res = await readFileTool.run({ path: 'nope.txt' }, makeCtx(ws));
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/read_file failed:.*ENOENT/);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('读目录 → ok=false 明确提示', async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(path.join(ws, 'd'));
      const res = await readFileTool.run({ path: 'd' }, makeCtx(ws));
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/not a regular file/);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('.. 逃逸与 cwd 外绝对路径都被拒绝', async () => {
    const ws = makeWorkspace();
    try {
      const escape1 = await readFileTool.run({ path: '../secret.txt' }, makeCtx(ws));
      expect(escape1.ok).toBe(false);
      expect(escape1.content).toMatch(/escapes the session workspace/);

      const escape2 = await readFileTool.run({ path: '/etc/passwd' }, makeCtx(ws));
      expect(escape2.ok).toBe(false);
      expect(escape2.content).toMatch(/escapes the session workspace/);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('超过 200KB 截断并附提示（含行范围），多字节切半不留替换字符', async () => {
    const ws = makeWorkspace();
    try {
      // 250KB 的 3 字节汉字，截断必然切在字符中间
      writeFileSync(path.join(ws, 'big.txt'), '你'.repeat(90_000));
      const res = await readFileTool.run({ path: 'big.txt' }, makeCtx(ws));
      expect(res.ok).toBe(true);
      expect(res.content).toMatch(/\[truncated: file is \d+ bytes, showing the first 204800 bytes \(lines 1-\d+\)\]$/);
      expect(res.content).not.toContain('�');
      expect(res.content.startsWith('你')).toBe(true);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('参数校验失败 → ok=false（不触碰文件系统）', async () => {
    const ws = makeWorkspace();
    try {
      const res = await readFileTool.run({ path: 123 }, makeCtx(ws));
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/invalid arguments for read_file/);
    } finally {
      cleanupWorkspace(ws);
    }
  });
});

describe('write_file', () => {
  it('写入并自动创建父目录，返回字节数', async () => {
    const ws = makeWorkspace();
    try {
      const res = await writeFileTool.run(
        { path: 'src/deep/a.txt', content: 'abc' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(true);
      expect(res.content).toMatch(/wrote 3 bytes to src\/deep\/a\.txt/);
      expect((await readFileTool.run({ path: 'src/deep/a.txt' }, makeCtx(ws))).content).toBe('abc');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('路径逃逸 → 拒绝且不产生任何写入', async () => {
    const ws = makeWorkspace();
    try {
      const res = await writeFileTool.run(
        { path: '../evil.txt', content: 'x' },
        makeCtx(ws),
      );
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/escapes the session workspace/);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('覆盖已有文件', async () => {
    const ws = makeWorkspace();
    try {
      const ctx = makeCtx(ws);
      await writeFileTool.run({ path: 'a.txt', content: 'old' }, ctx);
      await writeFileTool.run({ path: 'a.txt', content: 'new' }, ctx);
      expect((await readFileTool.run({ path: 'a.txt' }, ctx)).content).toBe('new');
    } finally {
      cleanupWorkspace(ws);
    }
  });
});

describe('list_dir', () => {
  it('目录在前、文件在后，分组展示；默认列出 cwd', async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(path.join(ws, 'zdir'));
      mkdirSync(path.join(ws, 'adir'));
      writeFileSync(path.join(ws, 'b.txt'), 'x');
      writeFileSync(path.join(ws, 'a.txt'), 'x');

      const res = await listDirTool.run({}, makeCtx(ws));
      expect(res.ok).toBe(true);
      const idx = (name: string) => res.content.indexOf(name);
      expect(res.content).toMatch(/directories:\n {2}adir\/\n {2}zdir\//);
      expect(res.content).toMatch(/files:\n {2}a\.txt\n {2}b\.txt/);
      expect(idx('directories:')).toBeLessThan(idx('files:'));
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('子目录路径与空目录', async () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(path.join(ws, 'sub'));
      const res = await listDirTool.run({ path: 'sub' }, makeCtx(ws));
      expect(res.ok).toBe(true);
      expect(res.content).toBe('(empty directory)');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('目标是文件 → ok=false', async () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(path.join(ws, 'f.txt'), 'x');
      const res = await listDirTool.run({ path: 'f.txt' }, makeCtx(ws));
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(/not a directory/);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  it('超过 500 条目截断并提示隐藏数量', async () => {
    const ws = makeWorkspace();
    try {
      for (let i = 0; i < 505; i++) {
        writeFileSync(path.join(ws, `f${String(i).padStart(4, '0')}.txt`), 'x');
      }
      const res = await listDirTool.run({}, makeCtx(ws));
      expect(res.ok).toBe(true);
      expect(res.content).toMatch(/\(5 more entries not shown\)/);
      expect(res.content).toContain('f0000.txt');
      expect(res.content).toContain('f0499.txt');
      expect(res.content).not.toContain('f0500.txt');
    } finally {
      cleanupWorkspace(ws);
    }
  });
});
