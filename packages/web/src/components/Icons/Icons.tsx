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

export function SearchIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
    className,
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return svg(<polyline points="6 9 12 15 18 9" />, className);
}

export function ChevronLeftIcon({ className }: IconProps) {
  return svg(<polyline points="15 18 9 12 15 6" />, className);
}

export function EllipsisHorizontalIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none" />
    </>,
    className,
  );
}

export function CheckCircleIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>,
    className,
  );
}

export function XCircleIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </>,
    className,
  );
}

export function InformationCircleIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>,
    className,
  );
}

export function ExclamationTriangleIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>,
    className,
  );
}

export function ClipboardIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
    </>,
    className,
  );
}

export function PencilIcon({ className }: IconProps) {
  return svg(
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
    className,
  );
}

export function TrashIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </>,
    className,
  );
}

export function PinIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </>,
    className,
  );
}

export function ListBulletIcon({ className }: IconProps) {
  return svg(
    <>
      <line x1="9" y1="6" x2="21" y2="6" />
      <line x1="9" y1="12" x2="21" y2="12" />
      <line x1="9" y1="18" x2="21" y2="18" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </>,
    className,
  );
}

export function DocumentDuplicateIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M8 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" />
      <path d="M16 4H6a2 2 0 0 0-2 2v10" />
    </>,
    className,
  );
}

export function QuestionMarkCircleIcon({ className }: IconProps) {
  return svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>,
    className,
  );
}

export function PanelLeftIcon({ className }: IconProps) {
  return svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </>,
    className,
  );
}

export function PanelRightIcon({ className }: IconProps) {
  return svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="15" y1="4" x2="15" y2="20" />
    </>,
    className,
  );
}

export function TerminalIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M4 17l6-5-6-5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>,
    className,
  );
}

export function CodeBracketIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M8 6l-6 6 6 6" />
      <path d="M16 6l6 6-6 6" />
    </>,
    className,
  );
}

export function PaperClipIcon({ className }: IconProps) {
  return svg(
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
    className,
  );
}

export function StopIcon({ className }: IconProps) {
  return svg(<rect x="6" y="6" width="12" height="12" rx="1.5" />, className);
}

export function ArrowPathIcon({ className }: IconProps) {
  return svg(
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v5h-5" />
    </>,
    className,
  );
}

export function CpuChipIcon({ className }: IconProps) {
  return svg(
    <>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <rect x="10" y="10" width="4" height="4" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </>,
    className,
  );
}

