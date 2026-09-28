/**
 * Sandbox 服务端扩展类型。
 *
 * 基础接口（SandboxProvider / ExecOptions / ExecResult / SandboxStatus）
 * 定义在 @yo-harness/core/types/sandbox，此处仅定义服务端特有的配置类型。
 */
export type {
  SandboxProvider,
  ExecOptions,
  ExecResult,
  SandboxStatus,
} from '@yo-harness/core/types/sandbox.js';

export interface SandboxConfig {
  provider: 'local' | 'docker';
  local?: { cwd: string };
  docker?: DockerSandboxConfig;
}

export interface DockerSandboxConfig {
  image: string;
  memoryLimit: number;
  cpuLimit: number;
  networkEnabled: boolean;
  poolSize: number;
  workdirMount: string;
}
