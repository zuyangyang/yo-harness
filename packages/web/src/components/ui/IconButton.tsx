import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: IconButtonSize;
  active?: boolean;
  children: ReactNode;
}

export function IconButton({
  label,
  size = 'md',
  active = false,
  className,
  children,
  ...rest
}: IconButtonProps): JSX.Element {
  const cls = ['ui-icon-btn', 'ui-icon-btn--' + size, active ? 'ui-icon-btn--active' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
