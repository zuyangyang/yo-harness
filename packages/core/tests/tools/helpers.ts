/**
 * 工具层测试共享设施：临时 workspace + ExecutionContext 替身。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLocalSandbox } from '../../src/sandbox/local-sandbox.js';
import type { SandboxProvider } from '../../src/types/sandbox.js';
import type { ExecutionContext } from '../../src/types/tools.js';

export function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'yo-tools-'));
}

export function cleanupWorkspace(ws: string): void {
  rmSync(ws, { recursive: true, force: true });
}

export function makeMockSandbox(): SandboxProvider {
  return {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    readFile: async () => Buffer.from(''),
    writeFile: async () => {},
    listDir: async () => [],
    getStatus: () => 'ready',
    destroy: async () => {},
  };
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
    sandbox: createLocalSandbox(cwd),
  };
}
