import { describe, expect, it } from 'vitest';

import { deriveTitle } from '../src/utils/title.js';

describe('deriveTitle', () => {
  it('空串 / 纯空白返回空串', () => {
    expect(deriveTitle('')).toBe('');
    expect(deriveTitle('   ')).toBe('');
    expect(deriveTitle('\t\n')).toBe('');
  });

  it('短文本原样返回并折叠空白', () => {
    expect(deriveTitle('帮我调研 tubi')).toBe('帮我调研 tubi');
    expect(deriveTitle('  帮我   调研   tubi  ')).toBe('帮我 调研 tubi');
  });

  it('不超过 maxLength 时不截断', () => {
    const text = 'a'.repeat(40);
    expect(deriveTitle(text)).toBe(text);
    expect(deriveTitle(text).endsWith('…')).toBe(false);
  });

  it('超过 maxLength 时截断并追加省略号', () => {
    const text = 'x'.repeat(100);
    const title = deriveTitle(text);
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title.endsWith('…')).toBe(true);
  });

  it('优先在空白处断句', () => {
    const text = 'word '.repeat(20).trim();
    const title = deriveTitle(text);
    expect(title.endsWith('…')).toBe(true);
    // 断点处不应把最后一个词截半：省略号前的字符应是空白被 trim 掉后的完整词尾
    expect(title.slice(0, -1).endsWith('word')).toBe(true);
  });

  it('优先在中英文标点处断句（标点位于后半段）', () => {
    const prefix = '这'.repeat(30);
    const title = deriveTitle(prefix + '。' + 'y'.repeat(40));
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe(prefix + '…');
  });

  it('自定义 maxLength 生效', () => {
    const text = 'y'.repeat(50);
    expect(deriveTitle(text, { maxLength: 10 }).length).toBeLessThanOrEqual(11);
  });
});
