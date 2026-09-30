/**
 * 会话标题派生（纯函数）。
 *
 * 规则（见 docs/SESSION-WORKSPACE-DESIGN.md §8）：
 * - 归一化：折叠所有连续空白为单个空格、去首尾空白；
 * - 截断：默认 40 字符，超长时优先在空白/中英文标点处断句，否则硬截断并追加 …；
 * - 空输入返回空串（调用方视作「未命名」）。
 */

export interface DeriveTitleOptions {
  maxLength?: number;
}

export function deriveTitle(text: string, options: DeriveTitleOptions = {}): string {
  const max = options.maxLength ?? 40;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return '';
  if (normalized.length <= max) return normalized;

  // 在 max 附近寻找最近的空白/标点作为断点，避免截断半个词
  const window = normalized.slice(0, max + 1);
  const cut = Math.max(
    window.lastIndexOf(' '),
    window.lastIndexOf('，'),
    window.lastIndexOf('。'),
    window.lastIndexOf('？'),
    window.lastIndexOf('！'),
    window.lastIndexOf(','),
    window.lastIndexOf('.'),
    window.lastIndexOf('?'),
    window.lastIndexOf('!'),
  );
  const end = cut > max * 0.5 ? cut : max;
  return normalized.slice(0, end).trim() + '…';
}
