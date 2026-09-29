/**
 * Main page layout: TopBar + Sidebar + Content + StatusBar + ApprovalDialog overlay.
 * Responsive: sidebar collapses on mobile.
 */
import { useCallback, useState } from 'react';

import { Sidebar } from './Sidebar/Sidebar.js';
import { ChatArea } from './Chat/ChatArea.js';
import { StatusBar } from './StatusBar/StatusBar.js';
import { MemoryManager } from './Memory/MemoryManager.js';
import { TaskList } from './Task/TaskList.js';
import { ApprovalDialog } from './Approval/ApprovalDialog.js';
import { TopBar } from './TopBar/TopBar.js';
import { useApprovalStore } from '../stores/approval.js';
import { useSessionStore } from '../stores/session.js';

type ViewTab = 'chat' | 'memory' | 'tasks';

export function MainLayout(): JSX.Element {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ViewTab>('chat');
  const [selectedModel, setSelectedModel] = useState('');

  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const removeApproval = useApprovalStore((s) => s.removeApproval);
  const createSession = useSessionStore((s) => s.createSession);
  const selectSession = useSessionStore((s) => s.selectSession);

  const handleDismissApproval = useCallback(
    (approvalId: string) => {
      removeApproval(approvalId);
    },
    [removeApproval],
  );

  const currentApproval = pendingApprovals[0] ?? null;

  const handleNewSession = async (): Promise<void> => {
    try {
      const session = await createSession(selectedModel);
      await selectSession(session.id);
    } catch {
      // Error is handled by session store
    }
  };

  return (
    <div className="main-layout">
      <div className={`sidebar-container ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <Sidebar onNewSession={handleNewSession} />
      </div>

      <div className="main-content">
        <TopBar
          activeTab={activeTab}
          onTabChange={(tab) => setActiveTab(tab as ViewTab)}
        />

        <div className="main-body">
          {activeTab === 'chat' && <ChatArea selectedModel={selectedModel} onModelChange={setSelectedModel} />}
          {activeTab === 'memory' && <MemoryManager />}
          {activeTab === 'tasks' && <TaskList />}
        </div>

        <StatusBar />
      </div>

      {currentApproval && (
        <ApprovalDialog
          request={currentApproval}
          onDismiss={() => handleDismissApproval(currentApproval.approvalId)}
        />
      )}
    </div>
  );
}
