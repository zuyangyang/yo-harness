import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';

import { NavRail } from './NavRail.js';
import { SidebarPane } from './SidebarPane.js';
import { HeaderBar } from './HeaderBar.js';
import { ContextPanel } from './ContextPanel.js';
import { StatusBar } from '../components/StatusBar/StatusBar.js';
import { ApprovalDialog } from '../components/Approval/ApprovalDialog.js';
import { CommandPalette } from '../components/ui/CommandPalette.js';
import { useApprovalStore } from '../stores/approval.js';
import { useSessionStore } from '../stores/session.js';
import { useUiStore } from '../stores/ui.js';

export function AppShell(): JSX.Element {
  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const removeApproval = useApprovalStore((s) => s.removeApproval);
  const createSession = useSessionStore((s) => s.createSession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const model = useUiStore((s) => s.model);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleContextPanel = useUiStore((s) => s.toggleContextPanel);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const currentApproval = pendingApprovals[0] ?? null;

  const handleNewSession = useCallback(async (): Promise<void> => {
    try {
      const session = await createSession(model);
      await selectSession(session.id);
    } catch {
      // 错误由 session store 记录
    }
  }, [createSession, model, selectSession]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (key === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (key === 'j') {
        e.preventDefault();
        toggleContextPanel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebar, toggleContextPanel]);

  return (
    <div className="app-shell">
      <NavRail />
      <SidebarPane onNewSession={() => { void handleNewSession(); }} />
      <main className="app-main">
        <HeaderBar />
        <div className="main-body">
          <Outlet />
        </div>
        <StatusBar />
      </main>
      <ContextPanel />
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      {currentApproval ? (
        <ApprovalDialog
          request={currentApproval}
          onDismiss={() => removeApproval(currentApproval.approvalId)}
        />
      ) : null}
    </div>
  );
}
