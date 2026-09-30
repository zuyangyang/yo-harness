export interface Shortcut {
  keys: string;
  description: string;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: '⌘ / Ctrl K', description: '打开命令面板' },
  { keys: '⌘ / Ctrl B', description: '折叠 / 展开侧栏' },
  { keys: '⌘ / Ctrl J', description: '折叠 / 展开上下文面板' },
  { keys: 'Enter', description: '发送消息' },
  { keys: 'Shift + Enter', description: '换行' },
  { keys: '/', description: '调用指令菜单' },
  { keys: 'Esc', description: '关闭弹层 / 清空输入' },
];
