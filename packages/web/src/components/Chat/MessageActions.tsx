import { ClipboardIcon, ArrowPathIcon, PencilIcon } from '../Icons/index.js';
import { IconButton } from '../ui/IconButton.js';
import { toast } from '../../stores/toast.js';

interface MessageActionsProps {
  text: string;
}

export function MessageActions({ text }: MessageActionsProps): JSX.Element {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <div className="message-actions">
      <IconButton label="复制" size="sm" onClick={() => { void copy(); }}>
        <ClipboardIcon className="icon-svg" />
      </IconButton>
      <IconButton label="重试" size="sm" onClick={() => toast.info('重试开发中')}>
        <ArrowPathIcon className="icon-svg" />
      </IconButton>
      <IconButton label="编辑" size="sm" onClick={() => toast.info('编辑开发中')}>
        <PencilIcon className="icon-svg" />
      </IconButton>
    </div>
  );
}
