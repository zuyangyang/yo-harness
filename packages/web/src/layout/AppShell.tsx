import { useCallback } from 'react';
import { Outlet } from 'react-router-dom';

import { NavRail } from './NavRail.js';
import { SidebarPane } from './SidebarPane.js';
import { HeaderBar } from './HeaderBar.js';
import { ContextPanel } from './ContextPanel.js';
import { StatusBar } from '../components/StatusBar/StatusBar.js';
import { ApprovalDialog } from '../components/Approval/ApprovalDialog.js';
import { useApprovalStore } from '../stores/approval.js';
import { useSessionStore } from '../stores/session.js';
import { useUiStore } from '../stores/ui.js';

export function AppShell(): JSX.Element {
  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const removeApproval = useApprovalStore((s) => s.removeApproval);
  const createSession = useSessionStore((s) => s.createSession);
  const selectSession = useSessionStore((s) => s.selectSession);
  const model = useUiStore((s) => s.model);

  const currentApproval = pendingApprovals[0] ?? null;

  const handleNewSession = useCallback(async (): Promise<void> => {
    try {
      const session = await createSession(model);
      await selectSession(session.id);
    } catch {
      // 错误由 session store 记录
    }
  }, [createSession, model, selectSession]);

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
      {currentApproval ? (
        <ApprovalDialog
          request={currentApproval}
          onDismiss={() => removeApproval(currentApproval.approvalId)}
        />
      ) : null}
    </div>
  );
}
