import type { ReactNode } from 'react';

export interface ComingSoonProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
  compact?: boolean;
}

export function ComingSoon({
  title = '功能开发中',
  description = '该功能正在建设中，敬请期待。',
  icon,
  compact = false,
}: ComingSoonProps): JSX.Element {
  return (
    <div className={'ui-coming' + (compact ? ' ui-coming--compact' : '')}>
      {icon ? <div className="ui-coming__icon">{icon}</div> : null}
      <div className="ui-coming__title">{title}</div>
      <div className="ui-coming__desc">{description}</div>
    </div>
  );
}
