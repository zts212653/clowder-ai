import type { ContextAttachment } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextAttachmentList, ContextAttachmentView } from '@/components/ContextAttachmentView';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';

const annotations = [
  {
    v: 1,
    id: 'ctx-quote-1',
    kind: 'quote',
    text: 'first selected passage',
    comment: 'comment for the first passage',
    source: { kind: 'message', threadId: 'thread-1', messageId: 'msg-1' },
  },
  {
    v: 1,
    id: 'ctx-quote-2',
    kind: 'quote',
    text: 'second selected passage',
    comment: 'comment for the second passage',
    source: { kind: 'message', threadId: 'thread-1', messageId: 'msg-1' },
  },
] as unknown as ContextAttachment[];

describe('ContextAttachment annotation summary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows one compact count and preserves every selected-text/comment pair in order', () => {
    act(() => root.render(<ContextAttachmentList attachments={annotations} compact />));

    const summary = container.querySelector<HTMLButtonElement>('[data-testid="context-annotations-summary"]');
    expect(summary?.textContent).toContain('2 annotations');
    expect(container.querySelector('[data-testid="context-annotation-item-ctx-quote-1"]')).toBeNull();

    act(() => summary?.click());

    expect(container.querySelector('[data-testid="context-annotation-item-ctx-quote-1"]')?.textContent).toContain(
      'first selected passage',
    );
    expect(container.querySelector('[data-testid="context-annotation-item-ctx-quote-1"]')?.textContent).toContain(
      'comment for the first passage',
    );
    expect(container.querySelector('[data-testid="context-annotation-item-ctx-quote-2"]')?.textContent).toContain(
      'second selected passage',
    );
    expect(container.querySelector('[data-testid="context-annotation-item-ctx-quote-2"]')?.textContent).toContain(
      'comment for the second passage',
    );
  });

  it('uses singular grammar when one annotation remains', () => {
    act(() => root.render(<ContextAttachmentList attachments={annotations.slice(0, 1)} compact />));

    const summary = container.querySelector<HTMLButtonElement>('[data-testid="context-annotations-summary"]');
    expect(summary?.textContent).toContain('1 annotation');
    expect(summary?.textContent).not.toContain('1 annotations');
  });

  it('renders the paired comment on a sent Quote card', () => {
    act(() => root.render(<ContextAttachmentView attachment={annotations[0]} />));
    const card = container.querySelector('[data-testid="context-attachment-ctx-quote-1"]');
    expect(card?.textContent).toContain('first selected passage');
    expect(card?.textContent).toContain('comment for the first passage');
  });

  it.each([
    'zh',
    'en',
  ] as const)('keeps every v2 file place numbered, with explicit localized details and exact removal: %s', (language) => {
    writeShellPresentation('v2');
    writeShellLanguage(language);
    const references: ContextAttachment[] = ['one', 'two'].map((id, index) => ({
      v: 1,
      id,
      kind: 'quote',
      text: `原文 ${id}`,
      ...(index ? { comment: '自己的批注' } : {}),
      source: {
        kind: 'workspace_file',
        path: 'work.md',
        worktreeId: 'work',
        ...(index ? { revision: `sha256:${'a'.repeat(64)}` } : {}),
      },
    }));
    const before = JSON.stringify(references),
      remove = vi.fn();
    act(() => root.render(<ContextAttachmentList attachments={references} compact onRemove={remove} />));
    const tags = container.querySelectorAll<HTMLButtonElement>('[data-testid="context-file-quote-tag"]');
    expect(tags).toHaveLength(2);
    expect(tags[0].textContent).toContain('1');
    expect(tags[1].textContent).toContain('2');
    expect(container.querySelector('[data-testid^="context-annotation-item-"]')).toBeNull();
    act(() => tags[0].click());
    expect(container.textContent).toContain(
      language === 'zh' ? '无法确认当前位置' : 'Current position cannot be confirmed',
    );
    act(() => tags[1].click());
    expect(container.querySelector('[data-testid="context-annotation-item-two"]')?.textContent).toContain('自己的批注');
    expect(container.textContent).toContain(language === 'zh' ? '批注' : 'Comment');
    expect(container.textContent).not.toContain('USER COMMENT');
    expect(container.querySelector('[data-testid="context-annotation-item-one"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-quote-remove="two"]')?.click());
    expect(remove).toHaveBeenCalledExactlyOnceWith('two');
    expect(JSON.stringify(references)).toBe(before);
  });
});
