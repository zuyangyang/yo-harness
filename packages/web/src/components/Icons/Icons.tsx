/**
 * Heroicons-style inline SVG icon components.
 * All icons use a 24x24 viewBox with currentColor stroke.
 */

interface IconProps {
  className?: string;
}

const base = 'icon-svg';

function svg(children: React.ReactNode, className?: string) {
  return (
    <svg
      className={`${base}${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function SunIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>,
    className,
  );
}

export function MoonIcon({ className }: IconProps) {
  return svg(
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
    className,
  );
}

export function CogIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
    className,
  );
}

export function ArrowRightOnRectangleIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" y1="12" x2="3" y2="12" />
    </>,
    className,
  );
}

export function ChatBubbleIcon({ className }: IconProps) {
  return svg(
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    className,
  );
}

export function SparklesIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z" />
      <path d="M5 3v2M3 5h2M19 17v2M17 19h2" />
    </>,
    className,
  );
}

export function ArrowUpIcon({ className }: IconProps) {
  return svg(
    <>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </>,
    className,
  );
}

export function WrenchScrewdriverIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </>,
    className,
  );
}

export function ClockIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>,
    className,
  );
}

export function CheckIcon({ className }: IconProps) {
  return svg(<polyline points="20 6 9 17 4 12" />, className);
}

export function XMarkIcon({ className }: IconProps) {
  return svg(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    className,
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return svg(<polyline points="9 18 15 12 9 6" />, className);
}

export function PlusIcon({ className }: IconProps) {
  return svg(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    className,
  );
}

export function CircleEmptyIcon({ className }: IconProps) {
  return svg(<circle cx="12" cy="12" r="9" />, className);
}

export function CircleHalfIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>,
    className,
  );
}

export function CircleFilledIcon({ className }: IconProps) {
  return svg(<circle cx="12" cy="12" r="9" fill="currentColor" />, className);
}

export function CircleDashedIcon({ className }: IconProps) {
  return svg(
    <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />,
    className,
  );
}
