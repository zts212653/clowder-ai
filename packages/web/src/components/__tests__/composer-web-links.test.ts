// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatReferenceScope } from '../chat-references/ChatReferenceScope';
import { composerWebLinks } from '../composer-web-links';
import { MarkdownContent } from '../MarkdownContent';

describe('composer web links use the eventual thread message semantics', () => {
  it.each([
    ['https://example.com/test这是说明', ['https://example.com/test这是说明']],
    ['https://example.com/test 这是说明', ['https://example.com/test']],
    ['https://example.com/test\n这是说明', ['https://example.com/test']],
    ['前缀 https://example.com?q=甲，乙 后缀', ['https://example.com?q=甲，乙']],
    ['https://example.com?q=）', ['https://example.com?q=）']],
    ['[说明](https://example.com/中文)', ['[说明](https://example.com/中文)']],
    ['<https://example.com>', ['<https://example.com>']],
    ['[说明][ref]\n\n[ref]: https://example.com/中文', ['[说明][ref]']],
    ['`https://example.com/中文`', ['`https://example.com/中文`']],
    ['  /cmd https://example.com/a  ', ['https://example.com/a']],
    ['www.example.com', ['www.example.com']],
    ['https://a.com https://a.com', ['https://a.com', 'https://a.com']],
    ['```\nhttps://example.com\n```', []],
    ['    https://example.com', ['https://example.com']],
    ['前文\n\n    https://example.com', []],
    ['公式 \\(https://example.com\\) 后', []],
    ['$$https://example.com$$', []],
    ['test@example.com ./README.md abc1234', []],
  ])('marks source constructs in %s', (source, expected) => {
    const result = composerWebLinks(source);
    expect(result.ranges.map(({ start, end }) => source.slice(start, end))).toEqual(expected);
    expect(result.unmapped).toBe(0);
  });

  it('updates reference use sites when their definition changes or disappears', () => {
    const use = '[说明][ref]';
    expect(composerWebLinks(`${use}\n\n[ref]: https://one.com`).ranges[0]?.href).toBe('https://one.com/');
    expect(composerWebLinks(`${use}\n\n[ref]: https://two.com`).ranges[0]?.href).toBe('https://two.com/');
    expect(composerWebLinks(use).ranges).toEqual([]);
  });

  it.each([
    'https\\://example.com',
    'https&#58;//example.com',
  ])('preserves the whole source node for a decoded URL: %s', (source) => {
    expect(composerWebLinks(source).ranges).toEqual([{ start: 0, end: source.length, href: 'https://example.com/' }]);
    expect(composerWebLinks(source).unmapped).toBe(0);
  });

  it('exposes the actual target when a prose source range cannot be mapped', () => {
    expect(composerWebLinks('说明 https\\://example.com 后')).toEqual({
      ranges: [],
      unmapped: 1,
      targets: ['https://example.com/'],
    });
  });

  it.each([
    '> https\\://example.com',
    '- https&#58;//example.com',
  ])('keeps quote and list prefixes outside a decoded link: %s', (source) => {
    const result = composerWebLinks(source);
    expect(result.ranges).toEqual([{ start: 2, end: source.length, href: 'https://example.com/' }]);
    expect(result.unmapped).toBe(0);
  });

  it('keeps duplicate links distinct across a selection replacement', () => {
    const result = composerWebLinks('https://a.com\nhttps://b.com');
    expect(result.ranges).toEqual([
      { start: 0, end: 13, href: 'https://a.com/' },
      { start: 14, end: 27, href: 'https://b.com/' },
    ]);
  });

  it.each([
    'https://example.com/test这是说明',
    'https://example.com?q=甲，乙 https://example.com?q=）',
    '[说明](https://example.com/中文)',
    '[说明][ref]\n\n[ref]: https://example.com/中文',
    '`https://example.com/中文`',
    'www.example.com https://a.com https://a.com',
    '公式 \\(https://example.com\\) 后',
    '```\nhttps://example.com\n```',
    'https\\://example.com',
    '说明 https\\://example.com 后',
    '说明 https&#58;//example.com 后',
  ])('agrees with actual thread Markdown rendering: %s', (source) => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      createElement(
        ChatReferenceScope,
        { value: 'future-thread' },
        createElement(MarkdownContent, { content: source.trim() }),
      ),
    );
    const targets = [...container.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .filter((link) => /^https?:/.test(link.href))
      .map((link) => link.href);
    expect(composerWebLinks(source).targets).toEqual(targets);
  });
});
