import { useLocation } from 'react-router-dom';

import { moduleLabelForPath } from '../config/navigation.js';
import { useUiStore } from '../stores/ui.js';
import { IconButton } from '../components/ui/IconButton.js';
import { PanelLeftIcon, PanelRightIcon } from '../components/Icons/index.js';

export function HeaderBar(): JSX.Element {
  const location = useLocation();
  const { sidebarCollapsed, contextPanelOpen, toggleSidebar, toggleContextPanel } = useUiStore();
  const label = moduleLabelForPath(location.pathname);

  return (
    <header className="header-bar">
      <div className="header-bar__left">
        <IconButton
          label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          onClick={toggleSidebar}
        >
          <PanelLeftIcon className="icon-svg" />
        </IconButton>
        <div className="header-bar__title">{label}</div>
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
