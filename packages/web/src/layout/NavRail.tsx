import { NavLink } from 'react-router-dom';

import { NAV_MODULES, NAV_TOOLS } from '../config/navigation.js';
import { useAuth } from '../hooks/useAuth.js';
import { useTheme } from '../hooks/useTheme.js';
import { IconButton } from '../components/ui/IconButton.js';
import { Tooltip } from '../components/ui/Tooltip.js';
import { toast } from '../stores/toast.js';
import {
  Logo,
  SunIcon,
  MoonIcon,
  QuestionMarkCircleIcon,
  ArrowRightOnRectangleIcon,
} from '../components/Icons/index.js';

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return 'nav-rail__item' + (isActive ? ' nav-rail__item--active' : '');
}

export function NavRail(): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const { logout } = useAuth();

  return (
    <nav className="nav-rail" aria-label="主导航">
      <NavLink to="/chat" className="nav-rail__logo" aria-label="Yo-Harness 首页">
        <Logo className="nav-rail__logo-icon" />
      </NavLink>

      <div className="nav-rail__group">
        {NAV_MODULES.map((item) => {
          const Icon = item.icon;
          return (
            <Tooltip key={item.id} label={item.label} side="right">
              <NavLink to={item.path} className={navLinkClass} aria-label={item.label}>
                <Icon className="icon-svg" />
              </NavLink>
            </Tooltip>
          );
        })}
      </div>

      <div className="nav-rail__spacer" />

      <div className="nav-rail__group">
        {NAV_TOOLS.map((item) => {
          const Icon = item.icon;
          return (
            <Tooltip key={item.id} label={item.label} side="right">
              <NavLink to={item.path} className={navLinkClass} aria-label={item.label}>
                <Icon className="icon-svg" />
              </NavLink>
            </Tooltip>
          );
        })}

        <Tooltip label={theme === 'dark' ? '切换到浅色' : '切换到深色'} side="right">
          <IconButton label="切换主题" onClick={toggleTheme}>
            {theme === 'dark' ? (
              <SunIcon className="icon-svg" />
            ) : (
              <MoonIcon className="icon-svg" />
            )}
          </IconButton>
        </Tooltip>

        <Tooltip label="帮助" side="right">
          <IconButton label="帮助" onClick={() => toast.info('快捷键帮助开发中')}>
            <QuestionMarkCircleIcon className="icon-svg" />
          </IconButton>
        </Tooltip>

        <Tooltip label="退出登录" side="right">
          <IconButton label="退出登录" onClick={logout}>
            <ArrowRightOnRectangleIcon className="icon-svg" />
          </IconButton>
        </Tooltip>
      </div>
    </nav>
  );
}
