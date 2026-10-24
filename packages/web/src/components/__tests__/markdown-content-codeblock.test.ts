import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(content: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
}

describe('MarkdownContent code block copy button', () => {
  it('renders copy button outside <pre> so textContent is clean', () => {
    const html = render('```js\nconsole.log("hello")\n```');
    // Button should be in a wrapper div, not inside <pre>
    // Structure: <div class="relative group ..."><button>复制</button><pre>...</pre></div>
    expect(html).toContain('<button');
    expect(html).toContain('复制');
    // The <pre> should NOT contain the button text
    const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/);
    expect(preMatch).toBeTruthy();
    expect(preMatch?.[1]).not.toContain('复制');
  });
});

describe('MarkdownContent file path linking', () => {
  it.each([
    'See /packages/api/src/routes/messages.ts:42 for details',
    'Check packages/web/src/app/page.tsx:10 for the fix',
    '入口验收：/home/user/projects/f309-dogfood-scratch/drinks.md',
    '改好了（/home/user/projects/f309-dogfood-scratch/desserts.md:3）',
  ])('keeps an unverified path literal without borrowing a project or inventing an editor link: %s', (content) => {
    const html = render(content);
    expect(html).toContain(content);
    expect(html).not.toContain('vscode://file');
    expect(html).not.toContain('data-chat-reference-kind=');
  });

  it('still leaves URLs and non-path slashes alone after full-width punctuation', () => {
    const html = render('链接：https://example.com/a/b.png，比例：16/9.5');
    expect(html).not.toContain('vscode://file');
  });
});
