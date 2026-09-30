import { filterSlashCommands } from '../../config/commands.js';

interface SlashMenuProps {
  query: string;
  selectedIndex: number;
  onSelect: (command: string) => void;
  onHover: (index: number) => void;
}

export function SlashMenu({ query, selectedIndex, onSelect, onHover }: SlashMenuProps): JSX.Element {
  const filtered = filterSlashCommands(query);

  if (filtered.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-menu__empty">没有匹配的指令</div>
      </div>
    );
  }

  return (
    <div className="slash-menu" role="listbox" aria-label="指令">
      {filtered.map((c, i) => (
        <button
          key={c.id}
          className={'slash-menu__item' + (i === selectedIndex ? ' slash-menu__item--active' : '')}
          role="option"
          aria-selected={i === selectedIndex}
          onMouseEnter={() => onHover(i)}
          onClick={() => onSelect(c.command)}
        >
          <span className="slash-menu__cmd">{c.command}</span>
          <span className="slash-menu__desc">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
