import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isRelativeMdLink, MarkdownContent, resolveRelativePath } from '@/components/MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });

/* ── isRelativeMdLink ────────────────────────────────── */
describe('isRelativeMdLink', () => {
  it('returns true for relative .md links', () => {
    expect(isRelativeMdLink('features/F046.md')).toBe(true);
    expect(isRelativeMdLink('../BACKLOG.md')).toBe(true);
    expect(isRelativeMdLink('./notes.mdx')).toBe(true);
  });

  it('returns true for .md links with fragment', () => {
    expect(isRelativeMdLink('README.md#section')).toBe(true);
  });

  it('returns false for absolute URLs', () => {
    expect(isRelativeMdLink('https://example.com/doc.md')).toBe(false);
    expect(isRelativeMdLink('http://example.com/doc.md')).toBe(false);
  });

  it('returns false for root-relative paths', () => {
    expect(isRelativeMdLink('/docs/README.md')).toBe(false);
  });

  it('returns false for non-markdown files', () => {
    expect(isRelativeMdLink('style.css')).toBe(false);
    expect(isRelativeMdLink('image.png')).toBe(false);
    expect(isRelativeMdLink('data.json')).toBe(false);
  });

  it('returns false for undefined/empty', () => {
    expect(isRelativeMdLink(undefined)).toBe(false);
    expect(isRelativeMdLink('')).toBe(false);
  });
});

/* ── resolveRelativePath ─────────────────────────────── */
describe('resolveRelativePath', () => {
  it('resolves simple filename against base dir', () => {
    expect(resolveRelativePath('docs/features', 'F046.md')).toBe('docs/features/F046.md');
  });

  it('resolves parent traversal (..)', () => {
    expect(resolveRelativePath('docs/features', '../BACKLOG.md')).toBe('docs/BACKLOG.md');
  });

  it('resolves multiple parent traversals', () => {
    expect(resolveRelativePath('docs/features/sub', '../../README.md')).toBe('docs/README.md');
  });

  it('resolves dot-slash (./) segments', () => {
    expect(resolveRelativePath('docs', './notes.md')).toBe('docs/notes.md');
  });

  it('strips fragment from relative path', () => {
    expect(resolveRelativePath('docs', 'README.md#section')).toBe('docs/README.md');
  });

  it('handles empty base', () => {
    expect(resolveRelativePath('', 'README.md')).toBe('README.md');
  });

  it('handles nested relative path', () => {
    expect(resolveRelativePath('docs', 'features/F063.md')).toBe('docs/features/F063.md');
  });
});

/* ── MarkdownContent with basePath ──────────────────── */
describe('MarkdownContent workspace link rendering', () => {
  function render(content: string, basePath?: string): string {
    return renderToStaticMarkup(
      React.createElement(MarkdownContent, { content, disableCommandPrefix: true, basePath }),
    );
  }

  it('renders relative md link as workspace-navigable when basePath is set', () => {
    const html = render('[Feature spec](features/F046.md)', 'docs');
    expect(html).toContain('在工作区中打开');
    expect(html).toContain('docs/features/F046.md');
    // Should NOT have target="_blank" for workspace links
    expect(html).not.toMatch(/target=.*_blank.*在工作区中打开/);
  });

  it('renders external links normally even with basePath', () => {
    const html = render('[GitHub](https://github.com)', 'docs');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('https://github.com');
  });

  it('renders relative md link as external when no basePath', () => {
    const html = render('[Feature spec](features/F046.md)');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('在工作区中打开');
  });
});
