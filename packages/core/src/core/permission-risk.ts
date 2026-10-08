/**
 * 自动审批（auto 模式）的确定性风险引擎。
 *
 * 设计原则（见 docs/APPROVAL-FLOW-DESIGN.md §7）：
 * - 确定性规则优先：无需 LLM、可解释、可审计（每个判定带 ruleId）；
 * - 失败关闭：无法判定的一律 ask；
 * - 工作区边界：工作区内写入/变更为低风险，越界或敏感目录一律 ask/deny；
 * - 高危硬规则（提权、递归删除、管道进 shell、动态执行…）永不自动放行。
 */
import path from 'node:path';

export type RiskLevel = 'none' | 'low' | 'medium' | 'high';
export type RiskDecision = 'allow' | 'ask' | 'deny';

export interface RiskAssessment {
  level: RiskLevel;
  decision: RiskDecision;
  /** 供审批卡展示「为什么需要你确认」 */
  reasons: string[];
  /** 命中的规则 id，供审计与设置页显示 */
  ruleIds: string[];
  /** 由引擎自动得出（true）还是必须人工（false） */
  automatic: boolean;
}

export interface AutoPolicy {
  /** 会话工作目录（workspace root）；空串表示未知，越界判定一律保守 */
  cwd: string;
  writesInWorkspace: boolean;
  networkReads: boolean;
  packageScripts: boolean;
  outsideWorkspace: 'ask' | 'deny';
}

export type ToolRisk = 'read' | 'write' | 'net' | 'danger';

export interface RiskTool {
  name: string;
  risk: ToolRisk;
}

export function defaultAutoPolicy(cwd: string): AutoPolicy {
  return {
    cwd,
    writesInWorkspace: true,
    networkReads: true,
    packageScripts: true,
    outsideWorkspace: 'ask',
  };
}

function allow(reason: string, ruleId: string, level: RiskLevel = 'low'): RiskAssessment {
  return { level, decision: 'allow', reasons: [reason], ruleIds: [ruleId], automatic: true };
}

function ask(reason: string, level: RiskLevel, ruleId: string): RiskAssessment {
  return { level, decision: 'ask', reasons: [reason], ruleIds: [ruleId], automatic: false };
}

function deny(reason: string, level: RiskLevel, ruleId: string): RiskAssessment {
  return { level, decision: 'deny', reasons: [reason], ruleIds: [ruleId], automatic: false };
}

// ─── 规则表 ───

const HARD_DENY: { id: string; re: RegExp; reason: string }[] = [
  { id: 'priv-escalation', re: /(^|[;&|]\s*)(sudo|doas)\b/, reason: '提权命令' },
  { id: 'switch-user', re: /(^|[;&|]\s*)su\s/, reason: '切换用户' },
  {
    id: 'disk-device',
    re: /\b(mkfs|fdisk|diskutil)\b|\bdd\b[^|]*\bof=\/dev\//,
    reason: '磁盘/设备操作',
  },
  {
    id: 'system-control',
    re: /\b(shutdown|reboot|halt|launchctl|systemctl|service|crontab)\b/,
    reason: '系统控制',
  },
  { id: 'process-kill', re: /\b(kill|pkill|killall)\b/, reason: '结束进程' },
  {
    id: 'git-destructive',
    re: /\bgit\s+(push|rebase|filter-branch)\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/,
    reason: '破坏性 git 操作',
  },
  {
    id: 'publish',
    re: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\bpip\s+install\s+(--user|-g)\b/,
    reason: '发布/全局安装',
  },
  {
    id: 'pipe-to-shell',
    re: /\|\s*(sh|bash|zsh|fish)\b|<\s*\(\s*(curl|wget)\b/,
    reason: '远程脚本直接执行',
  },
  { id: 'dynamic-exec', re: /(\$\(|`|\$\{)/, reason: '命令替换/动态执行' },
  { id: 'eval', re: /(^|[;&|]\s*)(eval|exec)\b/, reason: 'eval/exec 动态执行' },
];

const SENSITIVE_READ: { id: string; re: RegExp; reason: string }[] = [
  {
    id: 'env-dump',
    re: /(^|[;&|]\s*)(env|printenv|history)\b/,
    reason: '可能泄露环境变量/历史',
  },
  { id: 'secret-file', re: /(\.env\b|\.ssh\/|\.aws\/|\.gnupg\/|id_rsa)/, reason: '访问敏感凭据文件' },
];

const READONLY = new Set([
  'ls', 'pwd', 'cd', 'echo', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'tree', 'realpath',
  'basename', 'dirname', 'grep', 'rg', 'ag', 'fd', 'jq', 'yq', 'cut', 'sort', 'uniq', 'tr',
  'diff', 'comm', 'md5', 'shasum', 'sed', 'awk', 'which', 'type', 'man', 'help', 'date', 'cal',
  'uname', 'hostname', 'whoami', 'id', 'df', 'du', 'ps', 'node', 'python', 'python3', 'go',
  'rustc', 'find',
]);

const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe']);
const PACKAGE_READ = new Set(['ls', 'view', 'outdated', 'list']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'make', 'cargo', 'go']);
const WORKSPACE_MUTATION = new Set(['mkdir', 'touch', 'cp', 'mv', 'ln', 'rm', 'prettier', 'eslint', 'gofmt', 'black', 'rustfmt', 'chmod']);

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\n|\|)\s*/;
const REDIRECT_RE = /(>>?)\s*([^\s;&|]+)/g;
const SENSITIVE_PATH_RE = /(^|\/)(\.ssh|\.aws|\.gnupg)(\/|$)|^\/etc(\/|$)|(^|\/)\.env(\.|$)/;

export function isInsideWorkspace(cwd: string, target: string): boolean {
  if (cwd === '' || target === '') return false;
  const root = path.resolve(cwd);
  const abs = path.resolve(root, target);
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isSensitivePath(target: string): boolean {
  return SENSITIVE_PATH_RE.test(target);
}

/** 粗略分词：去引号、按空白切分（足够覆盖审批的启发式判断） */
function tokenize(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    .filter((t) => t !== '');
}

function pathArguments(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-'));
}

function classifySegment(argv: string[], policy: AutoPolicy, raw: string): RiskAssessment {
  const cmd = argv[0] ?? '';
  if (cmd === '') return ask('空命令片段', 'medium', 'empty-segment');

  if (READONLY.has(cmd)) {
    if (cmd === 'sed' && argv.some((a) => a === '-i' || a.startsWith('-i'))) {
      return ask('sed 就地修改', 'medium', 'sed-in-place');
    }
    if (cmd === 'awk' && /system\s*\(/.test(raw)) return ask('awk system() 执行', 'high', 'awk-system');
    if (cmd === 'find' && argv.some((a) => a === '-delete' || a === '-exec' || a === '-ok')) {
      return ask('find 删除/执行', 'high', 'find-danger');
    }
    return allow('只读命令', 'readonly');
  }

  if (cmd === 'git') {
    const sub = argv[1] ?? '';
    if (GIT_READ.has(sub)) return allow('git 只读子命令', 'git-read');
    return ask('git 写操作', 'medium', 'git-write');
  }

  if (PACKAGE_MANAGERS.has(cmd)) {
    const sub = argv[1] ?? '';
    if (PACKAGE_READ.has(sub)) return allow('包管理器只读子命令', 'package-read');
    if (policy.packageScripts) return allow('执行工作区脚本', 'package-script');
    return ask('执行工作区脚本', 'medium', 'package-script-gated');
  }

  if (cmd === 'rm') {
    const recursive = argv.some((a) => /^-[a-z]*r/.test(a) || a === '--recursive');
    const force = argv.some((a) => /^-[a-z]*f/.test(a));
    const targets = pathArguments(argv);
    const dangerous =
      targets.length === 0 ||
      targets.some((t) => isSensitivePath(t) || !isInsideWorkspace(policy.cwd, t));
    if ((recursive || force) && dangerous) return ask('递归/强制删除', 'high', 'recursive-delete');
    if (dangerous) return ask('删除工作区外文件', 'high', 'delete-outside');
    return allow('工作区内删除', 'workspace-mutation');
  }

  if (WORKSPACE_MUTATION.has(cmd)) {
    for (const target of pathArguments(argv)) {
      if (isSensitivePath(target)) return ask('修改敏感目录', 'high', 'sensitive-root');
      if (!isInsideWorkspace(policy.cwd, target)) return ask('修改工作区外文件', 'high', 'mutation-outside');
    }
    return allow('工作区内变更', 'workspace-mutation');
  }

  return ask('未识别的命令', 'medium', 'unknown-command');
}

function assessShell(args: Record<string, unknown>, policy: AutoPolicy): RiskAssessment {
  const command = typeof args.command === 'string' ? args.command : '';
  if (command.trim() === '') return ask('空命令', 'medium', 'shell-empty');

  for (const rule of HARD_DENY) {
    if (rule.re.test(command)) return ask(rule.reason, 'high', rule.id);
  }
  for (const rule of SENSITIVE_READ) {
    if (rule.re.test(command)) return ask(rule.reason, 'medium', rule.id);
  }

  for (const match of command.matchAll(REDIRECT_RE)) {
    const target = match[2] ?? '';
    if (isSensitivePath(target)) return ask('重定向到敏感路径', 'high', 'sensitive-redirect');
    if (!isInsideWorkspace(policy.cwd, target)) {
      return ask('重定向写入工作区外', 'high', 'redirect-outside');
    }
  }

  const segments = command.split(SEGMENT_SPLIT).filter((s) => s.trim() !== '');
  let sawMutation = false;
  for (const segment of segments) {
    const assessment = classifySegment(tokenize(segment), policy, segment);
    if (assessment.decision !== 'allow') return assessment;
    if (assessment.ruleIds.includes('workspace-mutation')) sawMutation = true;
  }
  return allow(sawMutation ? '工作区内变更' : '低风险命令', sawMutation ? 'workspace-mutation' : 'readonly');
}

function assessWrite(args: Record<string, unknown>, policy: AutoPolicy): RiskAssessment {
  const target = typeof args.path === 'string' ? args.path : '';
  if (target === '') return ask('缺少写入路径', 'medium', 'write-no-path');
  if (isSensitivePath(target)) return ask('写入敏感目录', 'high', 'sensitive-root');
  if (!isInsideWorkspace(policy.cwd, target)) {
    return policy.outsideWorkspace === 'deny'
      ? deny('写入工作区外', 'high', 'outside-workspace')
      : ask('写入工作区外', 'high', 'outside-workspace');
  }
  if (!policy.writesInWorkspace) return ask('工作区内写入', 'medium', 'write-gated');
  return allow('工作区内写入', 'write-in-workspace');
}

/** 对一次工具调用给出风险判定；auto 模式下 decision==='allow' 才自动放行 */
export function assessToolCall(
  tool: RiskTool,
  args: Record<string, unknown>,
  policy: AutoPolicy,
): RiskAssessment {
  switch (tool.risk) {
    case 'read':
      return allow('只读工具', 'read-tool');
    case 'net':
      return policy.networkReads
        ? allow('网络只读工具', 'net-read')
        : ask('网络访问', 'medium', 'net-gated');
    case 'write':
      return assessWrite(args, policy);
    case 'danger':
      return assessShell(args, policy);
    default:
      return ask('未知工具', 'medium', 'unknown-tool');
  }
}
