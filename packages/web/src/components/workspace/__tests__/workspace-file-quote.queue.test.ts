import { type ContextAttachment } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { addMediaSelectionToChat, removeMediaSelectionFromChat } from '@/components/content-review/media-chat-composer';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { composerInsertFromRecall } from '@/utils/true-recall';
import { addWorkspaceFileQuoteToChat } from '../workspace-file-quote';

const THREAD = 'thread-queue';
const HEX = 'd4'.repeat(32);
const SELECTION = { comment: '保留', path: 'docs/a.md', worktreeId: 'wt-1', revision: HEX } as const;
const text = (list: readonly ContextAttachment[] | undefined) =>
  (list ?? []).map((item) => (item.kind === 'quote' ? item.text : item.kind));
const reference = (i: number): ContextAttachment => ({
  v: 1,
  kind: 'thread',
  id: `t-${i}`,
  threadId: `ref-${i}`,
  title: 'kept',
});

beforeEach(() => {
  useChatStore.setState({ pendingChatInsert: null });
  useToastStore.setState({ toasts: [] });
  syncContextAttachmentDraftToStorage(THREAD, []);
});

describe('a place added while the input is full', () => {
  it('is refused with the reason shown to the person and told to the caller, and nothing is queued', () => {
    syncContextAttachmentDraftToStorage(
      THREAD,
      Array.from({ length: 12 }, (_, i) => reference(i)),
    );
    const result = addWorkspaceFileQuoteToChat(THREAD, { ...SELECTION, text: '第十三处' });
    expect(result).toEqual({ kind: 'refused', reason: 'too_large' });
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    const [toast] = useToastStore.getState().toasts;
    expect(toast?.message).toContain('请先发送或移除几个');
  });

  it('is added, and tells the caller so, while there is room', () => {
    expect(addWorkspaceFileQuoteToChat(THREAD, { ...SELECTION, text: '第一处' })).toEqual({ kind: 'added' });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

/** The answer to a recall exactly as `QueuePanel` and `TrueRecallActionButton` build it. */
function recallAnswer(thread: string, refs: ContextAttachment[] = []) {
  const insert = composerInsertFromRecall({
    verdict: 'zero_exposure',
    message: { id: 'source-message', threadId: thread, recall: { version: 1, exposure: 'none', recalledAt: 1 } },
    draft: {
      version: 1,
      ownerUserId: 'owner',
      threadId: thread,
      revision: 5,
      text: '召回的原话',
      updatedAt: 1,
      contentBlocks: refs.map((attachment) => ({ type: 'context_attachment', attachment })),
    },
    insertedRange: null,
    queue: [],
  } as never);
  if (!insert) throw new Error('no recall answer');
  return insert;
}

describe('a place added while the input has not yet taken the answer to a recall', () => {
  it('is refused with the reason shown and told to the caller; the answer and the stored draft are left as they were', () => {
    const saved = Array.from({ length: 11 }, (_, i) => reference(i));
    syncContextAttachmentDraftToStorage(THREAD, saved);
    const answer = recallAnswer(THREAD, saved);
    useChatStore.getState().setPendingChatInsert(answer);

    expect(addWorkspaceFileQuoteToChat(THREAD, { ...SELECTION, text: '第一处' })).toEqual({
      kind: 'refused',
      reason: 'recall_pending',
    });
    expect(addWorkspaceFileQuoteToChat(THREAD, { ...SELECTION, text: '第二处' }).kind).toBe('refused');
    expect(useChatStore.getState().pendingChatInsert).toBe(answer);
    expect(getContextAttachmentDraft(THREAD)).toEqual(saved);
    const [toast] = useToastStore.getState().toasts;
    expect(toast?.message).toContain('请稍后再引用一次');
  });

  it('is added once the input has taken the answer, and nothing was left waiting', () => {
    useChatStore.getState().setPendingChatInsert(recallAnswer(THREAD));
    addWorkspaceFileQuoteToChat(THREAD, { ...SELECTION, text: '第一处' });
    useChatStore.getState().setPendingChatInsert(null);
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(addWorkspaceFileQuoteToChat(THREAD, { ...SELECTION, text: '第一处' })).toEqual({ kind: 'added' });
    expect(text(useChatStore.getState().pendingChatInsert?.contextAttachments)).toEqual(['第一处']);
  });

  it('does not take the slot from another conversation’s answer either, and a newer answer is never overwritten', () => {
    const other = recallAnswer('other-thread', [reference(1)]);
    useChatStore.getState().setPendingChatInsert(other);
    expect(addWorkspaceFileQuoteToChat(THREAD, { ...SELECTION, text: '第一处' }).kind).toBe('refused');
    expect(useChatStore.getState().pendingChatInsert).toBe(other);
    // Replacing the slot while a refused place is "waiting" is no longer possible: nothing waits.
    const newer = recallAnswer('another-thread', [reference(2)]);
    useChatStore.getState().setPendingChatInsert(newer);
    useChatStore.getState().setPendingChatInsert(null);
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });

  it.each([
    ['an answer that only names its revision (the input takes that as saved too)', { serverRevision: 5 }],
    ['an answer that only owns the text', { authoritative: true }],
  ])('recognises %s', (_name, shape) => {
    useChatStore.getState().setPendingChatInsert({ threadId: THREAD, text: '召回的原话', ...shape });
    expect(addWorkspaceFileQuoteToChat(THREAD, { ...SELECTION, text: '第一处' }).kind).toBe('refused');
  });
});

describe('a place circled on a picture while the input has not yet taken the answer to a recall', () => {
  const TARGET = {
    title: 'cover.png',
    mediaType: 'image/png',
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'wt-1', path: 'art/cover.png' },
      expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
      reviewId: 'review-1',
      expectedReviewRevision: 3,
    },
  } as const;
  const REGION = { kind: 'image-region', x: 10, y: 20, width: 40, height: 30 } as const;

  it('is refused with its own reason, and the answer is left as it was', () => {
    const answer = recallAnswer(THREAD);
    useChatStore.getState().setPendingChatInsert(answer);
    const result = addMediaSelectionToChat(THREAD, TARGET, REGION);
    expect(result).toEqual({ kind: 'refused', reason: 'recall_pending' });
    expect(useChatStore.getState().pendingChatInsert).toBe(answer);
  });

  it('is refused for another conversation’s answer too: the slot is not taken from it', () => {
    const answer = recallAnswer('other-thread');
    useChatStore.getState().setPendingChatInsert(answer);
    expect(addMediaSelectionToChat(THREAD, TARGET, REGION)).toEqual({ kind: 'refused', reason: 'recall_pending' });
    expect(useChatStore.getState().pendingChatInsert).toBe(answer);
  });

  it('takes a place off as nothing while the answer waits: the answer is not changed', () => {
    const added = addMediaSelectionToChat(THREAD, TARGET, REGION);
    if (added.kind !== 'added') throw new Error('the place was not added');
    syncContextAttachmentDraftToStorage(THREAD, [added.attachment]);
    const answer = recallAnswer(THREAD);
    useChatStore.getState().setPendingChatInsert(answer);
    removeMediaSelectionFromChat(THREAD, added.attachment.id, added.selectionId);
    expect(useChatStore.getState().pendingChatInsert).toBe(answer);
  });
});
