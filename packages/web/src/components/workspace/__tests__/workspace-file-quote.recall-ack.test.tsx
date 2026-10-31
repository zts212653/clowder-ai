import type { ContextAttachment } from '@cat-cafe/shared';
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { flushComposerDraft } from '@/components/composer-draft-flush-registry';
import { useDurableComposerDraft } from '@/components/useDurableComposerDraft';
import { useChatStore } from '@/stores/chatStore';
import { addWorkspaceFileQuoteToChat } from '../workspace-file-quote';

const api = vi.hoisted(() => ({ calls: [] as RequestInit[] }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: async (_url: string, init?: RequestInit) => {
    if (init?.method) api.calls.push(init);
    return new Response(JSON.stringify(init?.method ? { revision: 6 } : { revision: 0, draft: null }));
  },
}));
const threadId = 'recall-queue-review';
function Composer() {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [contextAttachments, setContextAttachments] = useState<ContextAttachment[]>([]);
  const [, setIsPreparingImages] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useDurableComposerDraft({
    threadId,
    input,
    setInput,
    images,
    setImages,
    contextAttachments,
    setContextAttachments,
    replyToMessage: null,
    textareaRef,
    setIsPreparingImages,
  });
  return (
    <>
      <textarea ref={textareaRef} value={input} readOnly />
      <span data-testid="refs">{contextAttachments.length}</span>
    </>
  );
}
it('a quote met by a queued recall ACK is refused and left alone, and once the input has the ACK it is added and written like any local change', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.calls = [];
  useChatStore.setState({ pendingChatInsert: null });
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const place = {
    text: 'selected place',
    comment: 'revise',
    path: 'notes.md',
    worktreeId: 'wt',
    revision: `sha256:${'a'.repeat(64)}`,
  };
  try {
    await act(async () => root.render(<Composer />));
    for (let i = 0; i < 3; i++) await act(async () => Promise.resolve());
    let first: ReturnType<typeof addWorkspaceFileQuoteToChat> | undefined;
    await act(async () => {
      useChatStore.getState().setPendingChatInsert({
        threadId,
        text: 'recalled source',
        authoritative: true,
        serverRevision: 5,
        contextAttachments: [],
      });
      first = addWorkspaceFileQuoteToChat(threadId, place);
    });
    expect(first).toEqual({ kind: 'refused', reason: 'recall_pending' });
    expect(node.querySelector('[data-testid="refs"]')?.textContent).toBe('0');
    // The input has taken the answer: the place is an ordinary local change now.
    await act(async () => {
      addWorkspaceFileQuoteToChat(threadId, place);
    });
    expect(node.querySelector('[data-testid="refs"]')?.textContent).toBe('1');
    await act(async () => {
      await flushComposerDraft(threadId);
    });
    expect(
      api.calls.filter((call) => call.method === 'PUT'),
      'the actual durable draft consumer must write the quote added after the recall ACK',
    ).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    node.remove();
  }
});
