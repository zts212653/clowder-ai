import type { ArtifactReviewRound, ArtifactReviewView, ContextAttachment } from '@cat-cafe/shared';
import { act, type Dispatch, type SetStateAction, useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import {
  getThreadDraft,
  subscribeThreadDrafts,
  syncContextAttachmentDraftToStorage,
  syncDraftToStorage,
} from '@/components/thread-drafts';
import { useDurableComposerDraft } from '@/components/useDurableComposerDraft';
import { useChatStore } from '@/stores/chatStore';
import { ReviewRoundDecision } from '../ReviewRoundDecision';
import { useArtifactChatDiscussion } from '../useArtifactChatDiscussion';
import { compareAsset } from './media-compare.fixture';

const threadId = 'request-change-original-composer';
const words = 'ABCDEFGHIJKL';
const round: ArtifactReviewRound = {
  number: 2,
  asset: compareAsset(2),
  openedAt: '2026-10-13T23:00:00Z',
  state: 'awaiting_human',
  annotations: [],
  responses: [],
};
const view = {
  review: {
    reviewId: 'review-original',
    revision: 3,
    title: '封面',
    task: { threadId, taskId: 'task-original', ownerUserId: 'operator' },
  },
  authority: { taskRevision: 7, ownerCatId: 'codex-astra' },
} as unknown as ArtifactReviewView;
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'codex-astra',
        mentionPatterns: ['@原作品负责人'],
        displayName: '原负责人',
        roleDescription: '',
        avatar: '',
      },
    ],
  }),
}));
vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () =>
    Response.json({
      revision: 7,
      draft: {
        version: 1,
        ownerUserId: 'operator',
        threadId: 'request-change-original-composer',
        revision: 7,
        text: 'ABCDEFGHIJKL',
        updatedAt: 17,
      },
    }),
  ),
}));
let root: Root, node: HTMLDivElement;
function OriginalComposer() {
  const input = useSyncExternalStore(subscribeThreadDrafts, () => getThreadDraft(threadId));
  // Consume the actual ChatInput's synchronous thread-draft contract.
  const setInput: Dispatch<SetStateAction<string>> = useCallback(
    (change) => syncDraftToStorage(threadId, typeof change === 'function' ? change(getThreadDraft(threadId)) : change),
    [],
  );
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
function OriginalDecision() {
  const { discuss } = useArtifactChatDiscussion(view, round);
  return (
    <ReviewRoundDecision
      round={round}
      ownerUserId="operator"
      canWrite
      saving={false}
      draftKey="original-decision"
      act={vi.fn()}
      onDiscuss={discuss}
      compact
    />
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  writeShellPresentation('v2');
  syncDraftToStorage(threadId, words);
  syncContextAttachmentDraftToStorage(threadId, []);
  useChatStore.setState({ currentThreadId: threadId, pendingChatInsert: null, replyToMessage: null });
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});

it('moves a saved reason into the same draft with its original owner and keeps the editing selection', async () => {
  localStorage.setItem('original-decision', JSON.stringify({ body: '之前留下的两行\n保留我的说明', anchor: null }));
  await act(async () =>
    root.render(
      <>
        <OriginalComposer />
        <OriginalDecision />
      </>,
    ),
  );
  const input = node.querySelector('textarea');
  if (!input) throw new Error('Original composer absent');
  input.focus();
  input.setSelectionRange(3, 8, 'backward');
  const move = [...node.querySelectorAll('button')].find((button) => button.textContent === '放到聊天');
  expect(move).toBeDefined();
  await act(async () => move?.click());
  expect(input.value).toBe(`${words}\n之前留下的两行\n保留我的说明\n@原作品负责人`);
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([3, 8, 'backward']);
  expect(localStorage.getItem('original-decision')).toBeNull();
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  syncDraftToStorage(threadId, '');
  syncContextAttachmentDraftToStorage(threadId, []);
  useChatStore.setState({ pendingChatInsert: null });
  vi.unstubAllGlobals();
});
it('keeps the original draft selection through the real request-change attachment handoff', async () => {
  await act(async () =>
    root.render(
      <>
        <OriginalComposer />
        <OriginalDecision />
      </>,
    ),
  );
  const input = node.querySelector('textarea');
  if (!input) throw new Error('Original composer absent');
  input.focus();
  input.setSelectionRange(3, 8, 'backward');
  const request = [...node.querySelectorAll('button')].find((button) => button.textContent === '要求修改');
  expect(request).toBeDefined();
  await act(async () => request?.click());
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([3, 8, 'backward']);
  expect(input.value.startsWith(words)).toBe(true);
  expect(input.value).toBe(`${words}\n@原作品负责人`);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  await act(async () => request?.click());
  expect(input.value).toBe(`${words}\n@原作品负责人`);
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([3, 8, 'backward']);
});
