import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(content: string, opts?: { basePath?: string; worktreeId?: string }): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content, disableCommandPrefix: true, ...opts }));
}

/* ── Workspace images ────────────────────────────────── */
describe('MarkdownContent image rendering', () => {
  it('resolves relative image path via workspace API when basePath + worktreeId set', () => {
    const html = render('![screenshot](assets/screen.png)', { basePath: 'docs', worktreeId: 'wt-1' });
    expect(html).toContain('/api/workspace/file/raw');
    expect(html).toContain('path=docs%2Fassets%2Fscreen.png');
    expect(html).toContain('worktreeId=wt-1');
    expect(html).toContain('alt="screenshot"');
  });

  it('resolves parent-traversal image path', () => {
    const html = render('![logo](../images/logo.svg)', { basePath: 'docs/features', worktreeId: 'wt-1' });
    expect(html).toContain('path=docs%2Fimages%2Flogo.svg');
  });

  it('keeps external image URLs as-is', () => {
    const html = render('![ext](https://example.com/img.png)', { basePath: 'docs', worktreeId: 'wt-1' });
    expect(html).toContain('src="https://example.com/img.png"');
    expect(html).not.toContain('/api/workspace/file/raw');
  });

  it('keeps root-relative image paths as-is', () => {
    const html = render('![upload](/uploads/photo.png)', { basePath: 'docs', worktreeId: 'wt-1' });
    expect(html).not.toContain('/api/workspace/file/raw');
    expect(html).toContain('/uploads/photo.png');
  });

  it('keeps protocol-relative URLs as-is', () => {
    const html = render('![cdn](//cdn.example.com/img.png)', { basePath: 'docs', worktreeId: 'wt-1' });
    expect(html).not.toContain('/api/workspace/file/raw');
  });

  it('renders image without workspace resolution when no worktreeId', () => {
    const html = render('![pic](photo.jpg)', { basePath: 'docs' });
    expect(html).not.toContain('/api/workspace/file/raw');
  });
});

/* ── Task lists (GFM checkboxes) ─────────────────────── */
describe('MarkdownContent task list rendering', () => {
  it('renders unchecked task list item with checkbox', () => {
    const html = render('- [ ] Todo item');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('Todo item');
  });

  it('renders checked task list item with checked checkbox', () => {
    const html = render('- [x] Done item');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('Done item');
  });

  it('renders task list items with task-list styling', () => {
    const html = render('- [ ] A\n- [x] B');
    // task-list-item class is consumed by li handler → replaced with our styling
    expect(html).toContain('list-none');
    expect(html).toContain('-ml-5');
  });
});

/* ── h4-h6 headings ──────────────────────────────────── */
describe('MarkdownContent h4-h6 headings', () => {
  it('renders h4 with semibold styling', () => {
    const html = render('#### Heading 4');
    expect(html).toContain('<h4');
    expect(html).toContain('font-semibold');
    expect(html).toContain('Heading 4');
  });

  it('renders h5 with uppercase tracking', () => {
    const html = render('##### Heading 5');
    expect(html).toContain('<h5');
    expect(html).toContain('uppercase');
  });

  it('renders h6 with muted color', () => {
    const html = render('###### Heading 6');
    expect(html).toContain('<h6');
    expect(html).toContain('text-gray-500');
  });
});
