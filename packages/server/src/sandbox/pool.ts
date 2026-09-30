/**
 * SandboxPool：Docker 容器预热池。
 *
 * 冷启动容器 ~1-2s，通过预热池减少延迟。
 * acquire 从池中取容器（或新建），release 归还（或销毁）。
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type Docker from 'dockerode';

import { DockerProvider } from './docker.js';
import type { SandboxProvider } from '@yo-harness/core/types/sandbox.js';
import type { DockerSandboxConfig } from './interface.js';

export interface SandboxPoolConfig {
  poolSize: number;
  dockerConfig: DockerSandboxConfig;
  tempDirBase?: string;
}

export class SandboxPool {
  private pool: DockerProvider[] = [];
  private readonly tempDirBase: string;

  constructor(
    private readonly config: SandboxPoolConfig,
    private readonly docker: Docker,
  ) {
    this.tempDirBase = config.tempDirBase ?? os.tmpdir();
  }

  async warmUp(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.config.poolSize; i++) {
      promises.push(this.warmOne(`warm-${i}`));
    }
    await Promise.all(promises);
  }

  async acquire(sessionId: string, workspaceDir?: string): Promise<SandboxProvider> {
    const cached = this.pool.pop();
    if (cached) {
      const dir = workspaceDir ?? await this.createTempDir(sessionId);
      await cached.reset(dir);
      return cached;
    }

    const provider = new DockerProvider(this.docker, this.config.dockerConfig);
    const dir = workspaceDir ?? await this.createTempDir(sessionId);
    await provider.start(sessionId, dir);
    return provider;
  }

  release(provider: SandboxProvider): void {
    if (this.pool.length < this.config.poolSize && provider instanceof DockerProvider) {
      this.pool.push(provider);
    } else {
      void provider.destroy();
    }
  }

  get availableCount(): number {
    return this.pool.length;
  }

  async destroyAll(): Promise<void> {
    const promises = this.pool.map((p) => p.destroy());
    this.pool = [];
    await Promise.all(promises);
  }

  private async warmOne(id: string): Promise<void> {
    const provider = new DockerProvider(this.docker, this.config.dockerConfig);
    const dir = await this.createTempDir(id);
    await provider.start(id, dir);
    this.pool.push(provider);
  }

  private async createTempDir(sessionId: string): Promise<string> {
    const dir = path.join(this.tempDirBase, `yo-sandbox-${sessionId}-${Date.now()}`);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  }
}
