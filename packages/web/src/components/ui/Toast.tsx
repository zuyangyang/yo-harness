import { useEffect } from 'react';

import type { ToastItem, ToastType } from '../../stores/toast.js';
import { useToastStore } from '../../stores/toast.js';
import {
  CheckCircleIcon,
  XCircleIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from '../Icons/index.js';

const ICONS: Record<ToastType, JSX.Element> = {
  info: <InformationCircleIcon className="icon-svg" />,
  success: <CheckCircleIcon className="icon-svg" />,
  warning: <ExclamationTriangleIcon className="icon-svg" />,
  error: <XCircleIcon className="icon-svg" />,
};

export function ToastHost(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div className="ui-toast-host" aria-live="polite">
      {toasts.map((item) => (
        <ToastItemView key={item.id} item={item} />
      ))}
    </div>
  );
}

function ToastItemView({ item }: { item: ToastItem }): JSX.Element {
  const remove = useToastStore((s) => s.remove);

  useEffect(() => {
    if (item.duration <= 0) return undefined;
    const timer = setTimeout(() => remove(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.duration, item.id, remove]);

  return (
    <div className={'ui-toast ui-toast--' + item.type}>
      <span className="ui-toast__icon">{ICONS[item.type]}</span>
      <span className="ui-toast__message">{item.message}</span>
      <button className="ui-toast__close" onClick={() => remove(item.id)} aria-label="关闭通知">
        <XMarkIcon className="icon-svg" />
      </button>
    </div>
  );
}
