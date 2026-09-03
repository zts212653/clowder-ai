import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { CatData } from '@/hooks/useCatData';
import { refreshMentionData } from '@/lib/mention-highlight';

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

describe('MarkdownContent Team navigation', () => {
  it('renders a visible Team deep-link affordance for ordinary mentions', () => {
    refreshMentionData([
      {
        id: 'codex-sol',
        displayName: 'Sol',
        mentionPatterns: ['@codex-sol'],
        color: { primary: '#168F65', secondary: '#D8F3E7' },
        clientId: 'openai',
        defaultModel: 'gpt-5.6-sol',
        roleDescription: '',
        personality: '',
      } as CatData,
    ]);
    const html = render('@codex-sol 请复核');
    expect(html).toContain('aria-label="在猫猫团队中查看 codex-sol"');
    expect(html).toContain('<button');
  });

  it('keeps mentions inside markdown links non-interactive', () => {
    const html = render('[ask @codex-sol here](https://example.com/x)');
    const nestedHtml = render('[**@codex-sol** and *@codex-sol* and ~~@codex-sol~~](https://example.com/nested)');
    const workspaceHtml = render('[ask @codex-sol here](guide.md)', {
      basePath: 'docs',
      worktreeId: 'wt-1',
    });
    const nestedWorkspaceHtml = render('[**@codex-sol**](guide.md)', {
      basePath: 'docs',
      worktreeId: 'wt-1',
    });

    expect(html).toContain('<a href="https://example.com/x"');
    expect(html).toContain('@codex-sol');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-label="在猫猫团队中查看 codex-sol"');
    expect(nestedHtml).toContain('<strong');
    expect(nestedHtml).toContain('<em>');
    expect(nestedHtml).toContain('<del');
    expect(nestedHtml).not.toContain('<button');
    expect(nestedHtml).not.toContain('aria-label="在猫猫团队中查看 codex-sol"');
    expect(workspaceHtml).toContain('@codex-sol');
    expect(workspaceHtml).not.toContain('<button');
    expect(workspaceHtml).not.toContain('aria-label="在猫猫团队中查看 codex-sol"');
    expect(nestedWorkspaceHtml).toContain('<strong');
    expect(nestedWorkspaceHtml).not.toContain('<button');
    expect(nestedWorkspaceHtml).not.toContain('aria-label="在猫猫团队中查看 codex-sol"');
  });
});

/* ── Mermaid diagrams ────────────────────────────────── */
describe('MarkdownContent mermaid rendering', () => {
  it('renders mermaid fenced code as a diagram container instead of a generic code block', () => {
    const html = render('```mermaid\nflowchart TD\n  A[Draft] --> B[Workspace]\n```');

    expect(html).toContain('data-testid="mermaid-diagram"');
    expect(html).not.toContain('复制');
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
    expect(html).toContain('text-cafe-muted');
  });
});
