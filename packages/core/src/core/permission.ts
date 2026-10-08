/**
 * 审批策略（§6.4）。
 *
 * 风险矩阵：read / net 自动放行；write 询问（y / n / a，a = 本会话均
 * 允许同名工具）；danger（shell）按 shellMode：ask 每次询问 /
 * allowlist 命中才放行（未命中询问）/ yolo 全放行（含 write，用户
 * 显式 opting-in，CLI --yolo / config 均可设置）。
 *
 * 交互实现注入 ask 回调（Step 8 的 approval.tsx 提供）；withApprovalEvents
 * 装饰 ask，把审批问询落成 approval_request / approval_result 事件（事件流
 * 是审计与 resume 的依据，只有真正问询过的调用才产生审批事件）。
 * 非交互实现（`yo -p`）无人可问 → 未命中自动规则的均拒绝。
 *
 * 安全约定：ApprovalRequest.summary 只含路径 / 命令 / 大小等脱敏摘要，
 * 绝不携带写入内容或密钥（密钥不入事件 payload）。
 */
import type { AgentEvent } from '../types/events.js';
import type { Tool } from '../types/tools.js';
import { assessToolCall, defaultAutoPolicy, type AutoPolicy } from './permission-risk.js';

export type ShellMode = 'ask' | 'allowlist' | 'auto' | 'yolo';

/** UI 三级权限模式：询问 / 自动 / 完全访问 */
export type PermissionMode = 'ask' | 'auto' | 'full';

export interface PermissionSettings {
  /**
   * 三级权限模式。缺省时由 shellMode 推导（yolo→full，auto→auto，其余→ask），
   * 以保持旧配置与 CLI 的兼容。
   */
  mode?: PermissionMode;
  shellMode: ShellMode;
  /** allowlist 模式下自动放行的命令（字面量，或作为整词前缀） */
  shellAllowlist: string[];
  /** 等待人工审批的超时（ms）；0 / 缺省 = 不超时（fail-closed 在服务端实现） */
  approvalTimeoutMs?: number;
  /** 工作区外访问策略；缺省 ask */
  outsideWorkspace?: 'ask' | 'deny';
  /** auto 模式的细分开关 */
  auto?: {
    writesInWorkspace?: boolean;
    networkReads?: boolean;
    packageScripts?: boolean;
  };
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  mode: 'ask',
  shellMode: 'ask',
  shellAllowlist: [],
};

/** 解析生效的权限模式：显式 mode 优先，否则由 shellMode 推导 */
export function resolvePermissionMode(settings: PermissionSettings): PermissionMode {
  if (settings.mode !== undefined) return settings.mode;
  if (settings.shellMode === 'yolo') return 'full';
  if (settings.shellMode === 'auto') return 'auto';
  return 'ask';
}

export type ApprovalScope = 'once' | 'session';

export interface PermissionDecision {
  approved: boolean;
  scope: ApprovalScope;
}

/** 需要用户拍板的一次请求（summary 已脱敏） */
export interface ApprovalRequest {
  callId: string;
  toolName: string;
  summary: string;
}

export type ApprovalAnswer = 'yes' | 'always' | 'no';

/** CLI 注入的询问回调：渲染审批 UI、落库审批事件，返回用户选择 */
export type ApprovalAsk = (request: ApprovalRequest) => Promise<ApprovalAnswer>;

export interface PermissionManager {
  request(
    tool: Tool,
    args: Record<string, unknown>,
    callId: string,
    /** 会话工作目录；auto 模式据此判定工作区边界 */
    cwd?: string,
  ): Promise<PermissionDecision>;
  /** 运行期切换权限模式；不打断在途调用 */
  setMode(mode: PermissionMode): void;
  /** 当前生效模式 */
  getMode(): PermissionMode;
}

/** allowlist 匹配：字面量相等，或以 "<entry> " 开头（"npm test" 放行 "npm test -- foo"） */
export function matchesAllowlist(command: string, allowlist: string[]): boolean {
  return allowlist.some(
    (entry) => entry.length > 0 && (command === entry || command.startsWith(`${entry} `)),
  );
}

const PREVIEW_MAX = 40;
const SHELL_SUMMARY_MAX = 200;

function previewValue(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
  const flat = text.replaceAll(/\s+/g, ' ');
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

/**
 * 脱敏摘要：write_file 只报路径与字符数（内容可能含密钥，绝不进摘要）；
 * shell 展示命令本身（审批的前提是用户看得见将执行什么），截断 200 字符；
 * 其他工具展示参数名 + 截断值预览。
 */
export function summarizeToolCall(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'write_file') {
    const target = typeof args.path === 'string' ? args.path : '(invalid path)';
    const size = typeof args.content === 'string' ? args.content.length : 0;
    return `write_file ${target} (${size} chars)`;
  }
  if (toolName === 'shell') {
    const command = typeof args.command === 'string' ? args.command : '(invalid command)';
    return command.length > SHELL_SUMMARY_MAX ? `${command.slice(0, SHELL_SUMMARY_MAX)}…` : command;
  }
  const parts = Object.entries(args)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${previewValue(value)}`);
  return parts.length > 0 ? `${toolName} ${parts.join(' ')}` : toolName;
}

/** 由设置 + 会话 cwd 构造 auto 模式策略 */
function buildAutoPolicy(settings: PermissionSettings, cwd: string): AutoPolicy {
  const base = defaultAutoPolicy(cwd);
  return {
    ...base,
    ...(settings.auto?.writesInWorkspace !== undefined
      ? { writesInWorkspace: settings.auto.writesInWorkspace }
      : {}),
    ...(settings.auto?.networkReads !== undefined ? { networkReads: settings.auto.networkReads } : {}),
    ...(settings.auto?.packageScripts !== undefined
      ? { packageScripts: settings.auto.packageScripts }
      : {}),
    ...(settings.outsideWorkspace !== undefined
      ? { outsideWorkspace: settings.outsideWorkspace }
      : {}),
  };
}

/** 返回 undefined 表示"需要询问" */
function autoApprove(
  tool: Tool,
  args: Record<string, unknown>,
  settings: PermissionSettings,
  cwd = '',
): PermissionDecision | undefined {
  const mode = resolvePermissionMode(settings);
  // full：用户显式全量放行（含 write 与 danger）
  if (mode === 'full') return { approved: true, scope: 'once' };

  if (mode === 'ask') {
    // 保持既有语义：read/net 放行；danger 仅在 shellMode=allowlist 且命中白名单时放行
    if (tool.risk === 'read' || tool.risk === 'net') return { approved: true, scope: 'once' };
    if (tool.risk === 'danger' && settings.shellMode === 'allowlist') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (matchesAllowlist(command, settings.shellAllowlist)) {
        return { approved: true, scope: 'once' };
      }
    }
    return undefined;
  }

  // auto：显式白名单优先（用户明确放行的命令不再询问）
  if (tool.risk === 'danger') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (matchesAllowlist(command, settings.shellAllowlist)) {
      return { approved: true, scope: 'once' };
    }
  }

  // auto：确定性风险引擎判定；非 allow 一律询问（fail-closed）
  const assessment = assessToolCall(tool, args, buildAutoPolicy(settings, cwd));
  return assessment.decision === 'allow' ? { approved: true, scope: 'once' } : undefined;
}

export function createInteractivePermission(
  ask: ApprovalAsk,
  initialSettings: PermissionSettings = DEFAULT_PERMISSION_SETTINGS,
): PermissionManager {
  /** "a" 记住的本会话放行工具；仅 write 级（danger 不做会话级放行，避免一次 "a" 后所有命令裸奔） */
  const sessionAllowed = new Set<string>();
  let settings = initialSettings;

  return {
    async request(tool, args, callId, cwd) {
      if (sessionAllowed.has(tool.name)) {
        return { approved: true, scope: 'session' };
      }
      const auto = autoApprove(tool, args, settings, cwd);
      if (auto !== undefined) return auto;

      const answer = await ask({
        callId,
        toolName: tool.name,
        summary: summarizeToolCall(tool.name, args),
      });
      if (answer === 'no') return { approved: false, scope: 'once' };
      if (answer === 'always' && tool.risk === 'write') {
        sessionAllowed.add(tool.name);
        return { approved: true, scope: 'session' };
      }
      return { approved: true, scope: 'once' };
    },
    setMode(mode) {
      settings = { ...settings, mode };
    },
    getMode() {
      return resolvePermissionMode(settings);
    },
  };
}

/**
 * 非交互模式（`yo -p`）：无人可问 → 只放行无需询问的自动规则，
 * write 与未命中 allowlist 的 danger 一律拒绝（安全默认）。
 */
export function createNonInteractivePermission(
  settings: PermissionSettings = DEFAULT_PERMISSION_SETTINGS,
): PermissionManager {
  return {
    request(tool, args, _callId, cwd) {
      const auto = autoApprove(tool, args, settings, cwd);
      return Promise.resolve(auto ?? { approved: false, scope: 'once' as const });
    },
    // 无人可问：运行期切换不改变"只放行自动规则、其余拒绝"的语义
    setMode: () => {
      return;
    },
    getMode() {
      return resolvePermissionMode(settings);
    },
  };
}

/**
 * 装饰 ask：审批问询前后各落一个事件（approval_request / approval_result），
 * 事件经 sink 由调用方写入存储（CLI 装配层同时广播到总线）。
 * 只有真正问询过用户的调用才产生审批事件 —— 自动放行的不留痕，
 * 事件流因此与"用户拍板过什么"严格一致。
 */
export function withApprovalEvents(
  ask: ApprovalAsk,
  sink: (event: AgentEvent) => Promise<unknown>,
): ApprovalAsk {
  return async (request) => {
    await sink({
      type: 'approval_request',
      callId: request.callId,
      toolName: request.toolName,
      summary: request.summary,
    });
    const answer = await ask(request);
    await sink({
      type: 'approval_result',
      callId: request.callId,
      approved: answer !== 'no',
      scope: answer === 'always' ? 'session' : 'once',
    });
    return answer;
  };
}
