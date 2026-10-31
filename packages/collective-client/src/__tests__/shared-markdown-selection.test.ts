import { expect, it } from 'vitest';
import { resolveSharedMarkdownSelection } from '../shared-markdown-selection.js';

it('maps rendered Markdown across emphasis to the exact raw revision while refusing ambiguous or generated text', () => {
  const text = '# 指南\n\n这里是**共同**阅读的正文。\n\n相同文字\n\n相同文字';
  const span = resolveSharedMarkdownSelection(text, '共同阅读的正文');
  expect(span && text.slice(span.start, span.end)).toBe('共同**阅读的正文');
  expect(resolveSharedMarkdownSelection(text, '相同文字')).toBeNull();
  const last = text.lastIndexOf('相同文字');
  expect(resolveSharedMarkdownSelection(text, '相同文字', { start: last, end: text.length })).toEqual({
    start: last,
    end: text.length,
  });
  expect(resolveSharedMarkdownSelection('正文[^1]\n\n[^1]: 脚注', '1')).toBeNull();
});
