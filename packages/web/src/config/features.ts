/**
 * 功能注册表 —— 缺口功能的唯一来源。
 *
 * 状态三态：
 * - live：真实可用
 * - wip：界面可见，点击提示「开发中」
 * - planned：仅规划，暂不暴露入口
 *
 * status 改为 live 后，入口组件应切换为真实实现。
 */
export type FeatureStatus = 'live' | 'wip' | 'planned';

export interface FeatureEntry {
  id: string;
  label: string;
  description: string;
  status: FeatureStatus;
}

export const FEATURES: Record<string, FeatureEntry> = {
  artifacts: {
    id: 'artifacts',
    label: 'Artifacts',
    description: '查看与下载 Agent 产出的文件。',
    status: 'wip',
  },
  files: {
    id: 'files',
    label: 'Files',
    description: '浏览会话涉及的变更文件。',
    status: 'wip',
  },
  diff: {
    id: 'diff',
    label: 'Diff',
    description: '查看并接受/拒绝文件变更。',
    status: 'wip',
  },
  terminal: {
    id: 'terminal',
    label: 'Terminal',
    description: '在沙箱中运行命令。',
    status: 'wip',
  },
  settings: {
    id: 'settings',
    label: 'Settings',
    description: '偏好与账号设置。',
    status: 'wip',
  },
  share: {
    id: 'share',
    label: '分享',
    description: '导出或分享当前会话。',
    status: 'wip',
  },
  search: {
    id: 'search',
    label: '搜索',
    description: '跨会话、记忆与任务搜索。',
    status: 'wip',
  },
  notifications: {
    id: 'notifications',
    label: '通知',
    description: '查看系统与任务通知。',
    status: 'wip',
  },
  checkpoints: {
    id: 'checkpoints',
    label: '检查点',
    description: '查看与回滚文件检查点。',
    status: 'wip',
  },
  goal: {
    id: 'goal',
    label: '目标',
    description: '查看与编辑当前任务目标。',
    status: 'wip',
  },
  mcp: {
    id: 'mcp',
    label: 'Tools & MCP',
    description: '管理 MCP 服务器与外部工具。',
    status: 'wip',
  },
  models: {
    id: 'models',
    label: 'Models',
    description: 'Provider、API Key 与模型角色。',
    status: 'wip',
  },
  permissions: {
    id: 'permissions',
    label: 'Permissions',
    description: '审批策略与沙箱权限。',
    status: 'wip',
  },
  usage: {
    id: 'usage',
    label: '用量',
    description: 'Token 与成本明细。',
    status: 'wip',
  },
};

export function getFeature(id: string): FeatureEntry | undefined {
  return FEATURES[id];
}
