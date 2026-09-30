import { useMemo } from 'react';

import { useSessionStore } from '../../stores/session.js';
import { EmptyState } from '../../components/ui/EmptyState.js';
import { DocumentDuplicateIcon } from '../../components/Icons/index.js';

export function FilesPanel(): JSX.Element {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const eventsMap = useSessionStore((s) => s.events);
  const events = currentSessionId ? (eventsMap.get(currentSessionId) ?? []) : [];

  const files = useMemo(() => {
    const set = new Set<string>();
    for (const env of events) {
      if (env.payload.type === 'checkpoint_created') {
        for (const file of env.payload.files) set.add(file);
      }
    }
    return Array.from(set);
  }, [events]);

  if (files.length === 0) {
    return (
      <EmptyState
        icon={<DocumentDuplicateIcon className="icon-svg" />}
        title="暂无变更文件"
        description="当 Agent 写入文件并创建检查点时，这里会列出涉及的文件。"
      />
    );
  }

  return (
    <ul className="files-list">
      {files.map((file) => (
        <li key={file} className="files-list__item">
          {file}
        </li>
      ))}
    </ul>
  );
}
