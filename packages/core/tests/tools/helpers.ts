/**
 * 工具层测试共享设施：临时 workspace + ExecutionContext 替身。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExecutionContext } from '../../src/types/tools.js';

export function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'yo-tools-'));
}

export function cleanupWorkspace(ws: string): void {
  rmSync(ws, { recursive: true, force: true });
}

export function makeCtx(cwd: string): ExecutionContext {
  return {
    sessionId: 'test-session',
    cwd,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}
