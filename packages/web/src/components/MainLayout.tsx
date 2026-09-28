/**
 * 主页面布局：Sidebar + ChatArea + StatusBar + ApprovalDialog overlay。
 * 响应式：移动端 sidebar 可折叠。
 */
import { useCallback, useState } from 'react';

import { Sidebar } from './Sidebar/Sidebar.js';
import { ChatArea } from './Chat/ChatArea.js';
import { StatusBar } from './StatusBar/StatusBar.js';
import { MemoryManager } from './Memory/MemoryManager.js';
import { TaskList } from './Task/TaskList.js';
import { ApprovalDialog } from './Approval/ApprovalDialog.js';
import { useApprovalStore } from '../stores/approval.js';

type ViewTab = 'chat' | 'memory' | 'tasks';

export function MainLayout(): JSX.Element {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ViewTab>('chat');

  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const removeApproval = useApprovalStore((s) => s.removeApproval);

  const handleDismissApproval = useCallback(
    (approvalId: string) => {
      removeApproval(approvalId);
    },
    [removeApproval],
  );

  const currentApproval = pendingApprovals[0] ?? null;

  return (
    <div className="main-layout">
      <div className={`sidebar-container ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <Sidebar />
      </div>

      <div className="main-content">
        <div className="main-header">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
          <nav className="tab-nav">
            <button
              className={activeTab === 'chat' ? 'tab-active' : ''}
              onClick={() => setActiveTab('chat')}
            >
              Chat
            </button>
            <button
              className={activeTab === 'memory' ? 'tab-active' : ''}
              onClick={() => setActiveTab('memory')}
            >
              Memory
            </button>
            <button
              className={activeTab === 'tasks' ? 'tab-active' : ''}
              onClick={() => setActiveTab('tasks')}
            >
              Tasks
            </button>
          </nav>
        </div>

        <div className="main-body">
          {activeTab === 'chat' && <ChatArea />}
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
