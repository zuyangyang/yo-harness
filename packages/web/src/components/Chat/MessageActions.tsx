import { ClipboardIcon, ArrowPathIcon, PencilIcon } from '../Icons/index.js';
import { IconButton } from '../ui/IconButton.js';
import { toast } from '../../stores/toast.js';

interface MessageActionsProps {
  /** 复制按钮写入剪贴板的纯文本 */
  text: string;
  /** 重试：回退并重发本轮 user 消息；缺省隐藏该按钮 */
  onRetry?: (() => void) | undefined;
  /** 编辑：进入本轮 user 消息编辑态；缺省隐藏该按钮 */
  onEdit?: (() => void) | undefined;
  /** 动作进行中时禁用，避免重复触发 */
  disabled?: boolean | undefined;
}

/**
 * Turn 级消息动作行：复制 / 重新生成 / 编辑。
 *
 * 复制始终可用；重试与编辑由是否传入回调决定是否渲染，便于在
 * 运行中的 Turn（无动作行）或只读场景复用同一组件。
 */
export function MessageActions({
  text,
  onRetry,
  onEdit,
  disabled = false,
}: MessageActionsProps): JSX.Element {
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
      <IconButton label="复制" size="sm" disabled={disabled} onClick={() => { void copy(); }}>
        <ClipboardIcon className="icon-svg" />
      </IconButton>
      {onRetry !== undefined && (
        <IconButton label="重新生成" size="sm" disabled={disabled} onClick={onRetry}>
          <ArrowPathIcon className="icon-svg" />
        </IconButton>
      )}
      {onEdit !== undefined && (
        <IconButton label="编辑" size="sm" disabled={disabled} onClick={onEdit}>
          <PencilIcon className="icon-svg" />
        </IconButton>
      )}
    </div>
  );
}
