/**
 * DockerProvider：Docker 容器沙箱。
 *
 * 每个 session 分配一个独立容器，命令在容器内执行，
 * 文件系统隔离 + 资源限制（内存、CPU）+ 可选网络禁用。
 */
import Docker from 'dockerode';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { PassThrough } from 'node:stream';

import type {
  SandboxProvider,
  ExecOptions,
  ExecResult,
  SandboxStatus,
} from '@yo-harness/core/types/sandbox.js';
import type { DockerSandboxConfig } from './interface.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_CAP = 10 * 1024;

export class DockerProvider implements SandboxProvider {
  private container: Docker.Container | null = null;
  private status: SandboxStatus = 'starting';
  private workspaceDir: string = '';

  constructor(
    private readonly docker: Docker,
    private readonly config: DockerSandboxConfig,
  ) {}

  async start(sessionId: string, workspaceDir: string): Promise<void> {
    this.workspaceDir = workspaceDir;
    await fsp.mkdir(workspaceDir, { recursive: true });

    const container = await this.docker.createContainer({
      Image: this.config.image,
      WorkingDir: '/workspace',
      Env: [
        `SESSION_ID=${sessionId}`,
        'NODE_ENV=sandbox',
      ],
      HostConfig: {
        Binds: [`${workspaceDir}:/workspace`],
        Memory: this.config.memoryLimit,
        NanoCpus: this.config.cpuLimit * 1e9,
        NetworkMode: this.config.networkEnabled ? 'bridge' : 'none',
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        ReadonlyRootfs: false,
      },
      OpenStdin: false,
    });

    this.container = container;
    await container.start();
    this.status = 'ready';
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.container) {
      return { exitCode: 1, stdout: '', stderr: 'sandbox not started', timedOut: false };
    }

    this.status = 'busy';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cap = opts.maxOutputBytes ?? DEFAULT_OUTPUT_CAP;

    try {
      const exec = await this.container.exec({
        Cmd: ['sh', '-c', command],
        WorkingDir: opts.cwd ? `/workspace/${opts.cwd}` : '/workspace',
        AttachStdout: true,
        AttachStderr: true,
        Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
      });

      const stream = await exec.start({ Tty: false });

      const result = await Promise.race([
        this.collectOutput(stream, cap),
        this.timeout(timeoutMs),
      ]);

      if (result.timedOut) {
        try { await this.container.kill({ signal: 'SIGKILL' }); } catch { /* ignore */ }
      }

      const inspect = await exec.inspect();
      return {
        exitCode: inspect.ExitCode ?? (result.timedOut ? 137 : 1),
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
      };
    } finally {
      this.status = 'ready';
    }
  }

  async readFile(filePath: string): Promise<Buffer> {
    const abs = path.resolve(this.workspaceDir, filePath);
    return fsp.readFile(abs);
  }

  async writeFile(filePath: string, content: Buffer | string): Promise<void> {
    const abs = path.resolve(this.workspaceDir, filePath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }

  async listDir(dirPath: string): Promise<Dirent[]> {
    const abs = path.resolve(this.workspaceDir, dirPath);
    return fsp.readdir(abs, { withFileTypes: true });
  }

  getStatus(): SandboxStatus {
    return this.status;
  }

  async destroy(): Promise<void> {
    this.status = 'stopped';
    if (!this.container) return;
    try {
      await this.container.stop({ t: 3 });
    } catch { /* already stopped */ }
    try {
      await this.container.remove({ force: true });
    } catch { /* already removed */ }
    this.container = null;
  }

  async reset(newWorkspaceDir: string): Promise<void> {
    this.workspaceDir = newWorkspaceDir;
    await fsp.mkdir(newWorkspaceDir, { recursive: true });
  }

  private async collectOutput(
    stream: NodeJS.ReadableStream,
    cap: number,
  ): Promise<{ stdout: string; stderr: string; timedOut: false; stdoutTruncated: boolean; stderrTruncated: boolean }> {
    const stdout = new ByteCollector(cap);
    const stderr = new ByteCollector(cap);

    const demuxStream = new PassThrough();
    (stream as NodeJS.ReadableStream).pipe(demuxStream);

    return new Promise((resolve) => {
      const buf: Buffer[] = [];

      demuxStream.on('data', (chunk: Buffer) => {
        buf.push(chunk);
      });

      demuxStream.on('end', () => {
        const raw = Buffer.concat(buf);
        this.parseDemuxed(raw, stdout, stderr);
        resolve({ stdout: stdout.text(), stderr: stderr.text(), timedOut: false, stdoutTruncated: stdout.isTruncated, stderrTruncated: stderr.isTruncated });
      });

      demuxStream.on('error', () => {
        resolve({ stdout: stdout.text(), stderr: stderr.text(), timedOut: false, stdoutTruncated: stdout.isTruncated, stderrTruncated: stderr.isTruncated });
      });
    });
  }

  private parseDemuxed(
    raw: Buffer,
    stdout: ByteCollector,
    stderr: ByteCollector,
  ): void {
    let offset = 0;
    while (offset + 8 <= raw.length) {
      const streamType = raw[offset];
      const size = raw.readUInt32BE(offset + 4);
      offset += 8;
      const payload = raw.subarray(offset, offset + size);
      offset += size;

      if (streamType === 1) {
        stdout.push(Buffer.from(payload));
      } else if (streamType === 2) {
        stderr.push(Buffer.from(payload));
      }
    }
  }

  private timeout(ms: number): Promise<{ stdout: string; stderr: string; timedOut: true; stdoutTruncated: false; stderrTruncated: false }> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({ stdout: '', stderr: `timed out after ${ms}ms`, timedOut: true, stdoutTruncated: false, stderrTruncated: false });
      }, ms);
    });
  }
}

class ByteCollector {
  private readonly chunks: Buffer[] = [];
  private total = 0;
  private readonly cap: number;
  private overflow = false;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(chunk: Buffer): void {
    if (this.total >= this.cap) {
      this.overflow = true;
      return;
    }
    const keep = this.cap - this.total;
    if (chunk.length <= keep) {
      this.chunks.push(chunk);
      this.total += chunk.length;
    } else {
      this.chunks.push(chunk.subarray(0, keep));
      this.total = this.cap;
      this.overflow = true;
    }
  }

  get isTruncated(): boolean {
    return this.overflow;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
