import type { ContextAttachment } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextAttachmentList, ContextAttachmentView } from '@/components/ContextAttachmentView';

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
});
