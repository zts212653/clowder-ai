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
});
