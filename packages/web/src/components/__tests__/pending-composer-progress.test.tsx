import type { ContextAttachment } from '@cat-cafe/shared';
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushComposerDraft } from '@/components/composer-draft-flush-registry';
import { getThreadDraft, saveThreadDraftSelection, syncDraftToStorage } from '@/components/thread-drafts';
import { useDurableComposerDraft } from '@/components/useDurableComposerDraft';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const threadId = 'progress-target-exact';
const question = '请说说「核对交付」目前的进展。';
let root: Root;
let node: HTMLDivElement;
let resolveDraft: (value: Response) => void;
let writes: RequestInit[];

function Composer() {
  const [input, setInput] = useState(() => getThreadDraft(threadId));
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
  return <textarea ref={textareaRef} value={input} onChange={(event) => setInput(event.target.value)} />;
}
const draftResponse = (text: string) =>
  Response.json({
    revision: 7,
    draft: {
      version: 1,
      ownerUserId: 'owner',
      threadId,
      revision: 7,
      text,
      updatedAt: 17,
    },
  });
const queue = () => {
  const insert = { threadId, text: question, waitForDraft: true, preserveSelection: true };
  useChatStore.getState().setPendingChatInsert(insert);
};

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writes = [];
  useChatStore.setState({ currentThreadId: threadId, pendingChatInsert: null, replyToMessage: null });
  useToastStore.setState({ toasts: [] });
  syncDraftToStorage(threadId, '');
  vi.mocked(apiFetch).mockImplementation(async (_path, init) => {
    if (init?.method) {
      writes.push(init);
      return Response.json({ revision: 8 });
    }
    return new Promise<Response>((resolve) => {
      resolveDraft = resolve;
    });
  });
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
  syncDraftToStorage(threadId, '');
  useChatStore.setState({ pendingChatInsert: null });
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('waits for the actual target draft and appends the question as an unsent change at its real revision', async () => {
  await act(async () => {
    queue();
    root.render(<Composer />);
  });
  expect(node.querySelector('textarea')?.value).toBe('');
  expect(useChatStore.getState().pendingChatInsert?.text).toBe(question);
  await act(async () => resolveDraft(draftResponse('Server-only target draft')));
  expect(node.querySelector('textarea')?.value).toBe(`Server-only target draft\n${question}`);
  await act(async () => {
    await flushComposerDraft(threadId);
  });
  const body = JSON.parse(String(writes.at(-1)?.body));
  expect(body.expectedRevision).toBe(7);
  expect(body.text).toBe(`Server-only target draft\n${question}`);
  expect(writes.every((request) => request.method === 'PUT')).toBe(true);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});

it('keeps the original selection while appending to a mounted owner draft', async () => {
  await act(async () => root.render(<Composer />));
  await act(async () => resolveDraft(draftResponse('Original draft content')));
  const textarea = node.querySelector('textarea');
  if (!textarea) throw new Error('Original composer did not mount');
  textarea.focus();
  textarea.setSelectionRange(2, 9, 'backward');
  await act(async () => queue());
  expect(textarea.value).toBe(`Original draft content\n${question}`);
  expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual([2, 9, 'backward']);
});

it.each([
  true,
  false,
])('honors explicit media attachment selection preservation and retains the normal default: %s', async (preserveSelection) => {
  await act(async () => root.render(<Composer />));
  await act(async () => resolveDraft(draftResponse('Original draft content')));
  const textarea = node.querySelector('textarea');
  if (!textarea) throw new Error('Original composer did not mount');
  textarea.focus();
  textarea.setSelectionRange(3, 8, 'backward');
  await act(async () =>
    useChatStore.getState().setPendingChatInsert({
      threadId,
      text: '',
      preserveSelection,
      contextAttachments: [
        {
          v: 1,
          id: 'original-image',
          kind: 'media',
          title: '作品',
          mediaType: 'image/png',
          source: { kind: 'artifact-review', reviewId: 'original-review', round: 2, expectedReviewRevision: 3 },
          selections: [],
        },
      ],
    }),
  );
  expect(textarea.value).toBe('Original draft content');
  expect([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]).toEqual(
    preserveSelection ? [3, 8, 'backward'] : [22, 22, 'none'],
  );
});

it('does not discard the owner read when a newer recall ACK replaces the pending question', async () => {
  await act(async () => {
    queue();
    root.render(<Composer />);
  });
  await act(async () =>
    useChatStore.getState().setPendingChatInsert({
      threadId,
      text: 'Real recall ACK',
      serverRevision: 11,
      authoritative: true,
    }),
  );
  await act(async () => resolveDraft(draftResponse('Old target content')));
  expect(node.querySelector('textarea')?.value).toBe('Real recall ACK');
  expect(node.querySelector('textarea')?.value).not.toContain(question);
});

it('preserves the existing target draft and reports a failed owner read without preparing a question', async () => {
  syncDraftToStorage(threadId, 'Draft still available locally');
  await act(async () => {
    const insert = {
      threadId,
      text: question,
      waitForDraft: true,
      preserveSelection: true,
      draftReadFailure: { title: 'Ask for progress', message: 'The target draft could not be read' },
    };
    useChatStore.getState().setPendingChatInsert(insert);
    root.render(<Composer />);
  });
  await act(async () => resolveDraft(new Response(null, { status: 503 })));
  expect(node.querySelector('textarea')?.value).toBe('Draft still available locally');
  expect(writes).toEqual([]);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(useToastStore.getState().toasts.at(-1)?.message).toBe('The target draft could not be read');
});

it('keeps the target selection restored by the original browser mirror through owner hydration', async () => {
  const text = 'Original target draft from server';
  syncDraftToStorage(threadId, text);
  const previous = document.createElement('textarea');
  previous.value = text;
  previous.setSelectionRange(3, 11, 'forward');
  saveThreadDraftSelection(threadId, previous);
  await act(async () => {
    queue();
    root.render(<Composer />);
  });
  await act(async () => resolveDraft(draftResponse(text)));
  const textarea = node.querySelector('textarea');
  expect(textarea?.value).toBe(`${text}\n${question}`);
  expect([textarea?.selectionStart, textarea?.selectionEnd, textarea?.selectionDirection]).toEqual([3, 11, 'forward']);
});
