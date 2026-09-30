import type { CSSProperties } from 'react';

export interface SkeletonProps {
  variant?: 'text' | 'rect';
  width?: number | string;
  height?: number | string;
  className?: string;
}

export function Skeleton({
  variant = 'text',
  width,
  height,
  className,
}: SkeletonProps): JSX.Element {
  const cls = ['ui-skeleton', variant === 'text' ? 'ui-skeleton--text' : 'ui-skeleton--rect', className]
    .filter(Boolean)
    .join(' ');
  const style: CSSProperties = {};
  if (width !== undefined) style.width = typeof width === 'number' ? width + 'px' : width;
  if (height !== undefined) style.height = typeof height === 'number' ? height + 'px' : height;

  return <span className={cls} style={style} aria-hidden="true" />;
}
