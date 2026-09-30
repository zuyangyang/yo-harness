import { XCircleIcon } from '../Icons/index.js';

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = '加载失败',
  message,
  onRetry,
}: ErrorStateProps): JSX.Element {
  return (
    <div className="ui-error" role="alert">
      <div className="ui-error__icon">
        <XCircleIcon className="icon-svg" />
      </div>
      <div className="ui-error__title">{title}</div>
      {message ? <div className="ui-error__message">{message}</div> : null}
      {onRetry ? (
        <button className="ui-btn ui-btn--secondary ui-btn--sm" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
