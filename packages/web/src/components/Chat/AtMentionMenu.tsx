export interface MentionItem {
  id: string;
  kind: 'session' | 'file';
  label: string;
  insert: string;
}

interface AtMentionMenuProps {
  items: MentionItem[];
  selectedIndex: number;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}

export function AtMentionMenu({
  items,
  selectedIndex,
  onSelect,
  onHover,
}: AtMentionMenuProps): JSX.Element {
  if (items.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-menu__empty">没有可引用的会话或文件</div>
      </div>
    );
  }

  return (
    <div className="slash-menu" role="listbox" aria-label="引用">
      {items.map((item, i) => (
        <button
          key={item.id}
          className={'slash-menu__item' + (i === selectedIndex ? ' slash-menu__item--active' : '')}
          role="option"
          aria-selected={i === selectedIndex}
          onMouseEnter={() => onHover(i)}
          onClick={() => onSelect(item)}
        >
          <span className={'slash-menu__kind slash-menu__kind--' + item.kind}>
            {item.kind === 'session' ? '会话' : '文件'}
          </span>
          <span className="slash-menu__desc">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
