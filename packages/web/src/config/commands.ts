/**
 * 斜杠指令注册表（与 CLI 已有命令对齐，Web 端目前仅作输入提示）。
 */
export interface SlashCommand {
  id: string;
  command: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'help', command: '/help', description: '显示帮助' },
  { id: 'model', command: '/model', description: '显示当前 Provider / 模型' },
  { id: 'plan', command: '/plan', description: '进入规划模式，产出结构化计划' },
  { id: 'undo', command: '/undo', description: '撤销上一次文件变更' },
  { id: 'checkpoints', command: '/checkpoints', description: '列出当前会话检查点' },
  { id: 'goal', command: '/goal', description: '显示 / 设置当前目标' },
  { id: 'memory', command: '/memory', description: '管理记忆' },
  { id: 'sessions', command: '/sessions', description: '列出最近会话' },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.replace(/^\//, '');
  return SLASH_COMMANDS.filter((c) => c.command.slice(1).startsWith(q));
}
