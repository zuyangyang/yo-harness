import { useMemo } from 'react';

import { useSessionStore } from '../../stores/session.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { SparklesIcon } from '../../components/Icons/index.js';

interface MemoryEventItem {
  id: string;
  kind: 'injected' | 'extracted';
  label: string;
}

export function MemoryPanel(): JSX.Element {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const eventsMap = useSessionStore((s) => s.events);
  const events = currentSessionId ? (eventsMap.get(currentSessionId) ?? []) : [];

  const items = useMemo<MemoryEventItem[]>(() => {
    const out: MemoryEventItem[] = [];
    let seq = 0;
    for (const env of events) {
      const p = env.payload;
      if (p.type === 'memory_injected') {
        out.push({ id: 'inj-' + seq++, kind: 'injected', label: '注入 ' + p.count + ' 条记忆' });
      } else if (p.type === 'memory_extracted') {
        out.push({ id: 'ext-' + seq++, kind: 'extracted', label: '提取 ' + p.count + ' 条记忆' });
      }
    }
    return out;
  }, [events]);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<SparklesIcon className="icon-svg" />}
        title="暂无记忆流转"
        description="当会话结束或手动触发时，Agent 会提取并注入相关记忆。"
      />
    );
  }

  return (
    <ul className="memory-events">
      {items.map((item) => (
        <li key={item.id} className="memory-events__item">
          <span className={'memory-events__dot memory-events__dot--' + item.kind} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
