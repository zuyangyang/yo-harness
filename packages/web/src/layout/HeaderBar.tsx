import { useLocation } from 'react-router-dom';

import { moduleLabelForPath } from '../config/navigation.js';
import { useSessionStore } from '../stores/session.js';
import { useUiStore } from '../stores/ui.js';
import { IconButton } from '../components/ui/IconButton.js';
import { PanelLeftIcon, PanelRightIcon } from '../components/Icons/index.js';

export function HeaderBar(): JSX.Element {
  const location = useLocation();
  const { sidebarCollapsed, contextPanelOpen, toggleSidebar, toggleContextPanel } = useUiStore();
  // 顶部标题：Chat 页展示当前会话标题，其他模块仍显示模块名
  const sessionTitle = useSessionStore(
    (s) => s.sessions.find((session) => session.id === s.currentSessionId)?.title,
  );
  const isChat = location.pathname === '/chat' || location.pathname.startsWith('/chat/');
  const title =
    isChat && sessionTitle !== undefined && sessionTitle.trim() !== ''
      ? sessionTitle
      : moduleLabelForPath(location.pathname);

  return (
    <header className="header-bar">
      <div className="header-bar__left">
        <IconButton
          label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          onClick={toggleSidebar}
        >
          <PanelLeftIcon className="icon-svg" />
        </IconButton>
        <div className="header-bar__title" title={title}>
          {title}
        </div>
      </div>
      <div className="header-bar__right">
        <IconButton
          label={contextPanelOpen ? '收起上下文面板' : '展开上下文面板'}
          active={contextPanelOpen}
          onClick={toggleContextPanel}
        >
          <PanelRightIcon className="icon-svg" />
        </IconButton>
      </div>
    </header>
  );
}
