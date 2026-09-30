import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { NAV_MODULES, NAV_TOOLS } from '../../config/navigation.js';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { useTheme } from '../../hooks/useTheme.js';
import { toast } from '../../stores/toast.js';
import { SearchIcon } from '../Icons/index.js';

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface CommandPaletteProps {
  onClose: () => void;
}

export function CommandPalette({ onClose }: CommandPaletteProps): JSX.Element {
  const navigate = useNavigate();
  const { toggleSidebar, toggleContextPanel, model } = useUiStore();
  const { theme, toggleTheme } = useTheme();
  const createSession = useSessionStore((s) => s.createSession);
  const selectSession = useSessionStore((s) => s.selectSession);

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const nav: PaletteItem[] = [...NAV_MODULES, ...NAV_TOOLS].map((item) => ({
      id: 'nav-' + item.id,
      label: '前往 ' + item.label,
      run: () => {
        navigate(item.path);
        onClose();
      },
    }));

    const actions: PaletteItem[] = [
      {
        id: 'toggle-sidebar',
        label: '折叠 / 展开侧栏',
        hint: '⌘B',
        run: () => {
          toggleSidebar();
          onClose();
        },
      },
      {
        id: 'toggle-panel',
        label: '折叠 / 展开上下文面板',
        hint: '⌘J',
        run: () => {
          toggleContextPanel();
          onClose();
        },
      },
      {
        id: 'toggle-theme',
        label: theme === 'dark' ? '切换到浅色' : '切换到深色',
        run: () => {
          toggleTheme();
          onClose();
        },
      },
      {
        id: 'new-session',
        label: '新建会话',
        run: async () => {
          onClose();
          try {
            const session = await createSession(model);
            await selectSession(session.id);
          } catch {
            // 错误由 store 处理
          }
        },
      },
      {
        id: 'help',
        label: '快捷键帮助',
        run: () => {
          toast.info('快捷键帮助开发中');
          onClose();
        },
      },
    ];

    return [...nav, ...actions];
  }, [
    navigate,
    onClose,
    theme,
    toggleTheme,
    toggleSidebar,
    toggleContextPanel,
    createSession,
    selectSession,
    model,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.label.toLowerCase().includes(q));
  }, [items, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const active = filtered[index];

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      active?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmd-palette__input">
          <SearchIcon className="icon-svg" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索命令或页面…"
            aria-label="搜索命令"
          />
        </div>
        <div className="cmd-palette__list">
          {filtered.length === 0 ? (
            <div className="cmd-palette__empty">无匹配结果</div>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                className={'cmd-palette__item' + (i === index ? ' cmd-palette__item--active' : '')}
                onMouseEnter={() => setIndex(i)}
                onClick={item.run}
              >
                <span className="cmd-palette__label">{item.label}</span>
                {item.hint ? <span className="cmd-palette__hint">{item.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
