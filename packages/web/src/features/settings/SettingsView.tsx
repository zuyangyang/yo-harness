import { useState } from 'react';

import { useTheme, type Theme } from '../../hooks/useTheme.js';
import { ComingSoon } from '../../components/ui/ComingSoon.js';
import { ModelsSection } from './model/ModelsSection.js';
import { SHORTCUTS } from '../../config/shortcuts.js';

type SectionId = 'general' | 'models' | 'tools' | 'permissions' | 'shortcuts' | 'about';

interface SectionDef {
  id: SectionId;
  label: string;
  description: string;
}

const SECTIONS: SectionDef[] = [
  { id: 'general', label: '通用', description: '外观、密度与语言偏好。' },
  { id: 'models', label: '模型', description: '管理可用的模型与 Provider。' },
  { id: 'tools', label: '工具与 MCP', description: '管理工具、技能与 MCP 服务器。' },
  { id: 'permissions', label: '权限', description: '管理工具执行与审批策略。' },
  { id: 'shortcuts', label: '快捷键', description: '查看键盘快捷键。' },
  { id: 'about', label: '关于', description: '版本与项目信息。' },
];

export function SettingsView(): JSX.Element {
  const [section, setSection] = useState<SectionId>('general');
  const { theme, setTheme } = useTheme();

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="设置分类">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={'settings-nav__item' + (s.id === section ? ' settings-nav__item--active' : '')}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="settings-body">
        {section === 'general' ? (
          <GeneralSection theme={theme} onThemeChange={setTheme} />
        ) : section === 'models' ? (
          <ModelsSection />
        ) : section === 'shortcuts' ? (
          <ShortcutsSection />
        ) : (
          (() => {
            const meta = SECTIONS.find((s) => s.id === section);
            return (
              <ComingSoon
                title={(meta?.label ?? '') + ' · 开发中'}
                description={meta?.description}
              />
            );
          })()
        )}
      </div>
    </div>
  );
}

function GeneralSection({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}): JSX.Element {
  return (
    <>
      <h2 className="settings-heading">通用</h2>

      <section className="settings-section">
        <h3 className="settings-section__title">外观主题</h3>
        <div className="settings-theme" role="radiogroup" aria-label="主题">
          {(['light', 'dark'] as Theme[]).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={theme === t}
              className={'settings-theme__opt' + (theme === t ? ' settings-theme__opt--active' : '')}
              onClick={() => onThemeChange(t)}
            >
              {t === 'light' ? '浅色' : '深色'}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-section__title">界面密度</h3>
        <p className="settings-muted">开发中</p>
      </section>

      <section className="settings-section">
        <h3 className="settings-section__title">语言</h3>
        <p className="settings-muted">开发中</p>
      </section>
    </>
  );
}

function ShortcutsSection(): JSX.Element {
  return (
    <>
      <h2 className="settings-heading">快捷键</h2>
      <table className="shortcuts-table">
        <thead>
          <tr>
            <th>按键</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys}>
              <td>
                <code className="shortcut-keys">{s.keys}</code>
              </td>
              <td>{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
