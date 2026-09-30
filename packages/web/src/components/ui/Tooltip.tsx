import type { ReactNode } from 'react';

export type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: TooltipSide;
}

export function Tooltip({ label, children, side = 'right' }: TooltipProps): JSX.Element {
  return (
    <span className={'ui-tooltip ui-tooltip--' + side} data-tooltip={label}>
      {children}
    </span>
  );
}
