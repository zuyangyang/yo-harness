/**
 * 未知错误 → 可读字符串。工具 / 内核统一用它做兜底文案，
 * 避免各处自写 instanceof Error 分支。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
