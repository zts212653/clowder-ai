import { describe, expect, it } from 'vitest';
import { findGeneratedTextConstructs, projectMarkdownReadableText } from '../src/markdown-readable-text.js';

/**
 * The load-bearing property is not the exact separators — matching normalizes whitespace —
 * but that no visible occurrence is ever lost. Each case below therefore states either the
 * projected text or the occurrence count the reader can see.
 */
function occurrences(markdown: string, visible: string): number {
  return projectMarkdownReadableText(markdown).split(visible).length - 1;
}

describe('markdown readable-text projection (F294 quote plane v2)', () => {
  it('drops heading, emphasis, inline code and link syntax the reader never sees', () => {
    expect(projectMarkdownReadableText('## 修复真正的 P1')).toBe('修复真正的 P1');
    expect(projectMarkdownReadableText('浏览器按**渲染后**的 Markdown 取坐标')).toBe(
      '浏览器按渲染后的 Markdown 取坐标',
    );
    expect(projectMarkdownReadableText('导致你看到 `Message Bundle source validation failed`')).toBe(
      '导致你看到 Message Bundle source validation failed',
    );
    expect(projectMarkdownReadableText('见 [lessons-learned.md](/docs/lessons-learned.md) 的记录')).toBe(
      '见 lessons-learned.md 的记录',
    );
    expect(projectMarkdownReadableText('~~撤回~~ 与 _强调_ 与 ***三重***')).toBe('撤回 与 强调 与 三重');
  });

  it('drops list, blockquote and task markers but keeps their text', () => {
    expect(projectMarkdownReadableText('1. 修复真正的 P1')).toBe('修复真正的 P1');
    expect(projectMarkdownReadableText('- 静止态：整排操作消失')).toBe('静止态：整排操作消失');
    expect(projectMarkdownReadableText('> 引用的一句话')).toBe('引用的一句话');
    expect(projectMarkdownReadableText('- [x] 已完成项')).toBe('已完成项');
  });

  it('keeps fenced code contents verbatim and drops the fences', () => {
    expect(projectMarkdownReadableText('```ts\nconst a = **1**;\n```')).toBe('const a = **1**;');
    expect(occurrences('前\n```\n# not a heading\n```\n后', '# not a heading')).toBe(1);
  });

  it('projects a real table to its visible cell text', () => {
    expect(projectMarkdownReadableText('| 名称 | 状态 |\n| --- | --- |\n| **转发** | `绿` |')).toBe(
      '名称 状态\n\n转发 绿',
    );
  });

  it('keeps pipe rows that the renderer never turns into a table', () => {
    // Column counts do not match, so GFM leaves both rows as visible paragraph text.
    expect(occurrences('a | b | c\n| --- |\n\n`| --- |`', '| --- |')).toBe(2);
    // No delimiter row at all: a lone pipe row stays paragraph text.
    expect(occurrences('a | b\n\n| --- |\n\n`| --- |`', '| --- |')).toBe(2);
    // A lone dash run is paragraph text, not table syntax.
    expect(occurrences('--\n\n`--`', '--')).toBe(2);
  });

  it('decodes character references exactly as the renderer does', () => {
    expect(projectMarkdownReadableText('&copy;\n\n©')).toBe('©\n\n©');
    expect(projectMarkdownReadableText('&amp; &lt; &gt;')).toBe('& < >');
    expect(projectMarkdownReadableText('&#169; &#xA9;')).toBe('© ©');
    // An invalid numeric reference renders as the replacement character, not as its code point.
    expect(occurrences('&#128;\n\n�', '�')).toBe(2);
    expect(projectMarkdownReadableText('&notarealentity;')).toBe('&notarealentity;');
    expect(projectMarkdownReadableText('\\&copy;')).toBe('&copy;');
    expect(projectMarkdownReadableText('`&copy;`')).toBe('&copy;');
  });

  it('preserves constructs it does not model, because extra text fails closed', () => {
    // A thematic break renders as a rule; keeping its source can only add characters.
    expect(occurrences('段落\n\n---\n\n下一段', '段落')).toBe(1);
    expect(occurrences('段落\n\n---\n\n下一段', '下一段')).toBe(1);
    // Raw HTML is not rendered by the production stack, so keeping it is over-approximation.
    expect(occurrences('<b>粗</b>\n\n`<b>粗</b>`', '<b>粗</b>')).toBe(2);
  });

  it('reports constructs whose on-screen text the renderer generates from nothing', () => {
    // A footnote label is numbered by position and a KaTeX glyph replaces the TeX, so neither
    // exists in the source. No source-derived projection can carry them, which makes the
    // occurrence-count invariant unprovable rather than merely hard.
    expect(findGeneratedTextConstructs('正文[^a]\n\n[^a]: 脚注内容')).toEqual([
      'footnoteDefinition',
      'footnoteReference',
    ]);
    expect(findGeneratedTextConstructs('$$E=mc^2$$')).toEqual(['inlineMath']);
    // The chat renderer normalizes \\[…\\] into math before parsing, so treat it the same way.
    expect(findGeneratedTextConstructs('\\[E=mc^2\\]')).toEqual(['math']);
    // Ordinary content stays quotable.
    expect(findGeneratedTextConstructs('普通消息 `1` 与 | a | b |')).toEqual([]);
    expect(findGeneratedTextConstructs('单个 $x$ 不是行内公式')).toEqual([]);
  });

  it('is a no-op for plain text and preserves intentional punctuation', () => {
    expect(projectMarkdownReadableText('普通一句话，带 * 星号和 _ 下划线。')).toBe(
      '普通一句话，带 * 星号和 _ 下划线。',
    );
    expect(projectMarkdownReadableText('转义的 \\*星号\\* 显示为星号')).toBe('转义的 *星号* 显示为星号');
    expect(projectMarkdownReadableText('snake_case_name 不该被当成强调')).toBe('snake_case_name 不该被当成强调');
  });
});
