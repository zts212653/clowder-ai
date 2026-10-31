import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceLegacyTextNotes } from '../WorkspaceLegacyTextNotes';

it('continuing a quote captured in an old version preserves that source revision rather than certifying the current one', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const oldRevision = `sha256:${'a'.repeat(64)}`,
    currentRevision = `sha256:${'b'.repeat(64)}`;
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  useChatStore.setState({ currentThreadId: 'legacy-review', pendingChatInsert: null });
  try {
    await act(async () =>
      root.render(
        <WorkspaceLegacyTextNotes
          legacy={{
            items: [
              {
                kind: 'draft',
                key: 'old',
                sourceRevision: oldRevision,
                body: 'change the old place',
                quote: 'same sentence',
                target: { kind: 'text_quote', quote: 'same sentence' },
              },
            ],
            unreadable: 0,
            reconcile: vi.fn(),
            continued: vi.fn(() => 'settled' as const),
          }}
          locator={{ worktreeId: 'wt', path: 'notes.md' }}
          markdown
          currentRevision={currentRevision}
          onShowRecord={vi.fn()}
        />,
      ),
    );
    expect(node.textContent).toContain('写于文件的旧版本');
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[data-testid="workspace-legacy-text-continue"]')?.click(),
    );
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    expect(editor).not.toBeNull();
    await act(async () =>
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
    expect(attachment).toMatchObject({ kind: 'quote', text: 'same sentence', source: { revision: oldRevision } });
  } finally {
    act(() => root.unmount());
    node.remove();
  }
});

it('a continuation the input refuses leaves the old note unsettled and the card open', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const full = Array.from(
    { length: 12 },
    (_, i) => ({ v: 1, kind: 'thread', id: `t-${i}`, threadId: `ref-${i}`, title: 'kept' }) as const,
  );
  syncContextAttachmentDraftToStorage('legacy-refused', [...full]);
  useChatStore.setState({ currentThreadId: 'legacy-refused', pendingChatInsert: null });
  const continued = vi.fn(() => 'settled' as const);
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <WorkspaceLegacyTextNotes
          legacy={{
            items: [
              {
                kind: 'draft',
                key: 'old',
                sourceRevision: `sha256:${'a'.repeat(64)}`,
                body: 'change the old place',
                quote: 'same sentence',
                target: { kind: 'text_quote', quote: 'same sentence' },
              },
            ],
            unreadable: 0,
            reconcile: vi.fn(),
            continued,
          }}
          locator={{ worktreeId: 'wt', path: 'notes.md' }}
          markdown
          currentRevision={`sha256:${'a'.repeat(64)}`}
          onShowRecord={vi.fn()}
        />,
      ),
    );
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[data-testid="workspace-legacy-text-continue"]')?.click(),
    );
    await act(async () =>
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(continued).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="context-annotation-comment"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    node.remove();
    syncContextAttachmentDraftToStorage('legacy-refused', []);
  }
});
