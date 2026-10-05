import { describe, expect, it } from 'vitest';
import {
  findGeneratedTextConstructs,
  projectMarkdownReadableText,
  projectMarkdownReadableTextWithSourceMap,
} from '../src/markdown-readable-text.js';

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

describe('markdown readable-text source map (F309 rendered selection → raw range)', () => {
  const samples = [
    '# 松针与潮汐 · Pine needles\n\n第一段：**暮色里的灯塔**把航线折成两半，\nthe keeper writes.\n\nSecond — *salt*, 海风。',
    'Tom &amp; Jerry &copy; 2026 and \\*escaped\\* stars',
    '> 引用第一行\n> 引用第二行\n\n- 列表 **加粗**\n  续行\n- `inline code` 后',
    '| 名称 | 状态 |\n| --- | --- |\n| **转发** | `绿` |\n\n见 [链接文字](/docs/x.md)。',
    '```js\njs\n```\n\n```ts\nconst a = 1;\n```\n\n<div>raw html</div>\n\n---',
    // Characters outside the BMP are two UTF-16 units: offsets must count units, as string indexes do
    // (codex6-sol #4750 review: code points shifted every later offset by one).
    '`😀` after words',
    'text 😀 here **bold 🐾** end\n\n```\n🐾 code 👀\n```\n\n&#x1F600; entity',
  ];

  it('is the digested projection character for character, and every mapped offset names that character', () => {
    for (const markdown of samples) {
      const mapped = projectMarkdownReadableTextWithSourceMap(markdown);
      expect(mapped.text).toBe(projectMarkdownReadableText(markdown));
      expect(mapped.sourceOffsets).toHaveLength(mapped.text.length);
      mapped.sourceOffsets.forEach((offset, index) => {
        if (offset !== null) expect(markdown[offset], `${JSON.stringify(markdown)} @${index}`).toBe(mapped.text[index]);
      });
    }
  });

  const offsetOf = (markdown: string, visible: string) => {
    const mapped = projectMarkdownReadableTextWithSourceMap(markdown);
    const at = mapped.text.indexOf(visible);
    expect(at, visible).toBeGreaterThanOrEqual(0);
    return Array.from(visible, (_c, index) => mapped.sourceOffsets[at + index] ?? null);
  };

  it('maps text inside emphasis, across soft breaks and blockquote continuations to its raw characters', () => {
    const [first] = samples;
    expect(offsetOf(first!, '暮色')).toEqual([first!.indexOf('暮色'), first!.indexOf('暮色') + 1]);
    expect(offsetOf(first!, 'salt')[0]).toBe(first!.indexOf('salt'));
    const quote = samples[2]!;
    expect(offsetOf(quote, '引用第二行')[0]).toBe(quote.indexOf('引用第二行'));
    expect(offsetOf(quote, '续行')[0]).toBe(quote.indexOf('续行'));
    expect(offsetOf(quote, 'inline')[0]).toBe(quote.indexOf('inline'));
  });

  it('never maps a character reference, but maps the escaped character of a backslash escape', () => {
    const markdown = samples[1]!;
    expect(offsetOf(markdown, '&')).toEqual([null]);
    expect(offsetOf(markdown, '©')).toEqual([null]);
    expect(offsetOf(markdown, 'Jerry')[0]).toBe(markdown.indexOf('Jerry'));
    expect(offsetOf(markdown, '*escaped*')).toEqual([
      markdown.indexOf('*escaped'),
      ...Array.from('escaped', (_c, index) => markdown.indexOf('escaped') + index),
      markdown.lastIndexOf('*'),
    ]);
  });

  it('refuses to guess a code value that its own fence repeats', () => {
    const markdown = samples[4]!;
    const mapped = projectMarkdownReadableTextWithSourceMap(markdown);
    expect(mapped.text.startsWith('js')).toBe(true);
    expect(mapped.sourceOffsets.slice(0, 2)).toEqual([null, null]);
    expect(offsetOf(markdown, 'const a')[0]).toBe(markdown.indexOf('const a'));
  });
});
