import { useState } from 'react';

import { useUiStore } from '../stores/ui.js';
import { ComingSoon } from '../components/ui/ComingSoon.js';
import { PlanPanel } from '../features/plan/PlanPanel.js';
import { FilesPanel } from '../features/panels/FilesPanel.js';
import { MemoryPanel } from '../features/panels/MemoryPanel.js';
import {
  ListBulletIcon,
  DocumentDuplicateIcon,
  CodeBracketIcon,
  TerminalIcon,
  SparklesIcon,
} from '../components/Icons/index.js';

interface PanelTab {
  id: string;
  label: string;
  description: string;
  icon: (props: { className?: string }) => JSX.Element;
}

const TABS: PanelTab[] = [
  {
    id: 'plan',
    label: 'Plan',
    description: 'Agent 生成的执行计划与任务进度。',
    icon: ListBulletIcon,
  },
  {
    id: 'files',
    label: 'Files',
    description: '会话涉及的变更文件。',
    icon: DocumentDuplicateIcon,
  },
  {
    id: 'diff',
    label: 'Diff',
    description: '查看并接受/拒绝文件变更。',
    icon: CodeBracketIcon,
  },
  {
    id: 'terminal',
    label: 'Terminal',
    description: '在沙箱中运行命令。',
    icon: TerminalIcon,
  },
  {
    id: 'memory',
    label: 'Memory',
    description: '本会话注入与提取的记忆。',
    icon: SparklesIcon,
  },
];

export function ContextPanel(): JSX.Element | null {
  const { contextPanelOpen } = useUiStore();
  const [activeId, setActiveId] = useState<string>(TABS[0]?.id ?? 'plan');

  if (!contextPanelOpen) return null;

  const activeTab = TABS.find((tab) => tab.id === activeId) ?? TABS[0];

  return (
    <aside className="context-panel" aria-label="上下文面板">
      <div className="context-panel__tabs" role="tablist">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              className={
                'context-panel__tab' + (tab.id === activeId ? ' context-panel__tab--active' : '')
              }
              role="tab"
              aria-selected={tab.id === activeId}
              onClick={() => setActiveId(tab.id)}
            >
              <Icon className="icon-svg" />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="context-panel__body">
        {activeId === 'plan' ? (
          <PlanPanel />
        ) : activeId === 'files' ? (
          <FilesPanel />
        ) : activeId === 'memory' ? (
          <MemoryPanel />
        ) : (
          <ComingSoon
            title={(activeTab?.label ?? '') + ' · 开发中'}
            description={activeTab?.description}
            icon={activeTab ? <activeTab.icon className="icon-svg" /> : undefined}
          />
        )}
      </div>
    </aside>
  );
}
