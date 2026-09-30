import { useTheme } from '../../hooks/useTheme.js';
import { Logo, SunIcon, MoonIcon } from '../Icons/index.js';

interface TopBarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function TopBar({ activeTab, onTabChange }: TopBarProps): JSX.Element {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="topbar-logo">
          <Logo className="topbar-logo-icon" />
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
        <button className="theme-toggle-btn" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
          {theme === 'dark' ? <SunIcon className="icon-theme" /> : <MoonIcon className="icon-theme" />}
        </button>
      </div>
    </div>
  );
}
