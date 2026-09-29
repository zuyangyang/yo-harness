/**
 * TopBar: Logo + Tab navigation + Model selector.
 */
import { ModelSelector } from '../Model/ModelSelector.js';

interface TopBarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
}

export function TopBar({ activeTab, onTabChange, selectedModel, onModelChange }: TopBarProps): JSX.Element {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-logo">
          <span className="topbar-logo-icon">⚡</span>
          <span>Yo-Harness</span>
        </div>
        <nav className="tab-nav">
          <button className={activeTab === 'chat' ? 'tab-active' : ''} onClick={() => onTabChange('chat')}>
            Chat
          </button>
          <button className={activeTab === 'memory' ? 'tab-active' : ''} onClick={() => onTabChange('memory')}>
            Memory
          </button>
          <button className={activeTab === 'tasks' ? 'tab-active' : ''} onClick={() => onTabChange('tasks')}>
            Tasks
          </button>
        </nav>
      </div>
      <div className="topbar-right">
        <ModelSelector value={selectedModel} onChange={onModelChange} />
      </div>
    </div>
  );
}
