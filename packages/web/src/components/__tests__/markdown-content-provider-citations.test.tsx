import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '../MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });
const tag = (value: unknown) => `\uE200genui\uE202${JSON.stringify(value)}\uE201`;
const unresolved = tag({ citation: { refs: ['turn64view2', 'turn64view3'] } });
function render(content: string, providerCitations = true) {
  return renderToStaticMarkup(<MarkdownContent content={content} providerCitations={providerCitations} />);
}

describe('cloud provider citation display', () => {
  it('keeps paragraph/table content and ordinary source links without leaking private reference JSON', () => {
    const raw = `正文${unresolved}\n\n| 论文 | 判断 |\n| --- | --- |\n| 示例 | 原文结论${unresolved} |\n\n[原文](https://example.org/paper)`;
    const html = render(raw);
    expect(html).toContain('正文');
    expect(html).toContain('<table ');
    expect(html).toContain('原文结论');
    expect(html).toContain('https://example.org/paper');
    expect(html).not.toContain('genui');
    expect(html).not.toContain('turn64view');
    expect(html.match(/部分引用未附来源链接/g)).toHaveLength(1);
    expect(raw).toContain(unresolved);
  });

  it('renders only a supplied safe source URL and never guesses a URL from a turn ref', () => {
    const html = render(tag({ citation: { ref: 'turn2view0', url: 'https://example.org/source', title: '论文原文' } }));
    expect(html).toContain('href="https://example.org/source"');
    expect(html).toContain('论文原文');
    expect(html).not.toContain('部分引用未附来源链接');
    const unsafe = render(tag({ citation: { ref: 'turn2view0', url: 'javascript:alert(1)' } }));
    expect(unsafe).not.toContain('javascript:');
    expect(unsafe).toContain('部分引用未附来源链接');
  });

  it('preserves fenced, inline and indented code and leaves non-provider/user Markdown unchanged', () => {
    for (const content of [`\`\`\`json\n${unresolved}\n\`\`\``, `\`${unresolved}\``, `    ${unresolved}`]) {
      expect(render(content)).toContain('genui');
      expect(render(content)).not.toContain('部分引用未附来源链接');
    }
    expect(render(unresolved, false)).toContain('genui');
  });

  it('does not expose an unfinished streaming envelope or execute malformed citation payloads', () => {
    expect(render('前文\uE200genui\uE202{"citation":{"ref":"turn')).not.toContain('genui');
    const bad = render('前文\uE200genui\uE202{"citation":{broken}}\uE201 后文');
    expect(bad).toContain('前文');
    expect(bad).toContain('后文');
    expect(bad).not.toContain('{broken}');
    expect(render(tag({ citation: { url: 'https://example.org/', title: '<script>bad()</script>' } }))).not.toContain(
      '<script>',
    );
  });

  it('holds each partial marker prefix during streaming and preserves unrelated genui payloads', () => {
    const prefix = '\uE200genui\uE202';
    for (let length = 1; length < prefix.length; length += 1)
      expect(render(`前文${prefix.slice(0, length)}`)).not.toContain(prefix.slice(0, length));
    const unrelated = render(tag({ chart: { label: 'do not erase an unrelated widget' } }));
    expect(unrelated).toContain('do not erase an unrelated widget');
    expect(unrelated).not.toContain('部分引用未附来源链接');
  });

  it('treats backticks inside citation data as data rather than Markdown code', () => {
    const html = render(tag({ citation: { url: 'https://example.org/source', title: '`quoted` source' } }));
    expect(html).toContain('href="https://example.org/source"');
    expect(html).not.toContain('genui');
    expect(html).not.toContain('citation');
  });
});
