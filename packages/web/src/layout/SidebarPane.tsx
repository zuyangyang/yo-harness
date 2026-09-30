import { Sidebar } from '../components/Sidebar/Sidebar.js';
import { useUiStore } from '../stores/ui.js';

interface SidebarPaneProps {
  onNewSession: (workspaceId?: string | null) => void;
}

export function SidebarPane({ onNewSession }: SidebarPaneProps): JSX.Element {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    <div className={'sidebar-pane' + (sidebarCollapsed ? ' sidebar-pane--collapsed' : '')}>
      <Sidebar onNewSession={onNewSession} />
    </div>
  );
}
