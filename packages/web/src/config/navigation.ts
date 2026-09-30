/**
 * 一级导航配置：NavRail 与路由的唯一来源。
 */
import {
  ChatBubbleIcon,
  ListBulletIcon,
  SparklesIcon,
  DocumentDuplicateIcon,
  CogIcon,
} from '../components/Icons/index.js';

export type NavIcon = (props: { className?: string }) => JSX.Element;

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: NavIcon;
}

/** 业务模块（中段） */
export const NAV_MODULES: NavItem[] = [
  { id: 'chat', label: 'Chat', path: '/chat', icon: ChatBubbleIcon },
  { id: 'tasks', label: 'Tasks', path: '/tasks', icon: ListBulletIcon },
  { id: 'memory', label: 'Memory', path: '/memory', icon: SparklesIcon },
  { id: 'artifacts', label: 'Artifacts', path: '/artifacts', icon: DocumentDuplicateIcon },
];

/** 工具模块（下段） */
export const NAV_TOOLS: NavItem[] = [
  { id: 'settings', label: 'Settings', path: '/settings', icon: CogIcon },
];

const ALL_NAV_ITEMS: NavItem[] = [...NAV_MODULES, ...NAV_TOOLS];

export function moduleLabelForPath(pathname: string): string {
  const found = ALL_NAV_ITEMS.find(
    (item) => pathname === item.path || pathname.startsWith(item.path + '/'),
  );
  return found ? found.label : 'Chat';
}
