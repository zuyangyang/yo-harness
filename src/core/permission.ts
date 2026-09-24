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

export type ShellMode = 'ask' | 'allowlist' | 'yolo';

export interface PermissionSettings {
  shellMode: ShellMode;
  /** allowlist 模式下自动放行的命令（字面量，或作为整词前缀） */
  shellAllowlist: string[];
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  shellMode: 'ask',
  shellAllowlist: [],
};

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
  request(tool: Tool, args: Record<string, unknown>, callId: string): Promise<PermissionDecision>;
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

/** 返回 undefined 表示"需要询问" */
function autoApprove(
  tool: Tool,
  args: Record<string, unknown>,
  settings: PermissionSettings,
): PermissionDecision | undefined {
  // yolo：用户显式全量放行（含 write 与 danger）
  if (settings.shellMode === 'yolo') return { approved: true, scope: 'once' };
  if (tool.risk === 'read' || tool.risk === 'net') return { approved: true, scope: 'once' };
  if (tool.risk === 'write') return undefined;
  // danger（shell）按 shellMode
  if (settings.shellMode === 'allowlist') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (matchesAllowlist(command, settings.shellAllowlist)) {
      return { approved: true, scope: 'once' };
    }
  }
  return undefined;
}

export function createInteractivePermission(
  ask: ApprovalAsk,
  settings: PermissionSettings = DEFAULT_PERMISSION_SETTINGS,
): PermissionManager {
  /** "a" 记住的本会话放行工具；仅 write 级（danger 不做会话级放行，避免一次 "a" 后所有命令裸奔） */
  const sessionAllowed = new Set<string>();

  return {
    async request(tool, args, callId) {
      if (sessionAllowed.has(tool.name)) {
        return { approved: true, scope: 'session' };
      }
      const auto = autoApprove(tool, args, settings);
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
    request(tool, args) {
      const auto = autoApprove(tool, args, settings);
      return Promise.resolve(auto ?? { approved: false, scope: 'once' as const });
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
