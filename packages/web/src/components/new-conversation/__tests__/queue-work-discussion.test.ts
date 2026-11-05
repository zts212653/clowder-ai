import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { getThreadDraft, syncDraftToStorage, threadContextAttachmentDrafts } from '../../thread-drafts';
import { queueWorkDiscussion } from '../queue-work-discussion';

const artifact: GlobalArtifactDTO = {
  threadId: 'original-work-thread',
  threadTitle: 'Original conversation',
  sourceMessageId: 'original-publication',
  catId: 'codex61-sol',
  type: 'image',
  name: 'Original work.png',
  url: '/uploads/original.png',
  createdAt: 10,
};
const failure = { title: 'Draft unavailable', message: 'Preserve the original draft.' };
beforeEach(() => {
  useChatStore.setState({ pendingChatInsert: null });
  syncDraftToStorage(artifact.threadId, 'My original unsent words');
});
afterEach(() => {
  useChatStore.setState({ pendingChatInsert: null });
  syncDraftToStorage(artifact.threadId, '');
  threadContextAttachmentDrafts.delete(artifact.threadId);
});
it('queues the exact source quote and original author for append after target draft hydration', () => {
  expect(queueWorkDiscussion(artifact, '@codex61-sol ', failure)).toBe(true);
  const queued = useChatStore.getState().pendingChatInsert;
  expect(queued).toMatchObject({ threadId: artifact.threadId, text: '@codex61-sol ', waitForDraft: true });
  expect(queued?.authoritative).not.toBe(true);
  expect(queued?.serverRevision).toBeUndefined();
  expect(queued?.contextAttachments).toEqual([
    expect.objectContaining({
      kind: 'quote',
      text: 'Original work.png\n/uploads/original.png',
      source: {
        kind: 'message',
        threadId: artifact.threadId,
        messageId: artifact.sourceMessageId,
        senderCatId: 'codex61-sol',
      },
    }),
  ]);
  expect(getThreadDraft(artifact.threadId)).toBe('My original unsent words');
});
it('preserves words and references already queued for the same original composer', () => {
  useChatStore.setState({
    pendingChatInsert: {
      threadId: artifact.threadId,
      text: 'Already queued',
      contextAttachments: [
        { v: 1, id: 'existing', kind: 'thread', threadId: 'other-reference', title: 'Other reference' },
      ],
    },
  });
  expect(queueWorkDiscussion(artifact, '@codex61-sol ', failure)).toBe(true);
  expect(useChatStore.getState().pendingChatInsert).toMatchObject({
    text: 'Already queued\n@codex61-sol ',
    contextAttachments: [expect.objectContaining({ id: 'existing' }), expect.objectContaining({ kind: 'quote' })],
  });
});
it.each([true, false])('does not steal a pending authoritative or another-thread insertion: %s', (authoritative) => {
  const pending = {
    threadId: authoritative ? artifact.threadId : 'another-thread',
    text: 'Keep this insertion',
    authoritative,
  };
  useChatStore.setState({ pendingChatInsert: pending });
  expect(queueWorkDiscussion(artifact, '@codex61-sol ', failure)).toBe(false);
  expect(useChatStore.getState().pendingChatInsert).toBe(pending);
  expect(getThreadDraft(artifact.threadId)).toBe('My original unsent words');
});
it('does not manufacture a source message or an author when its coordinates are absent', () => {
  expect(queueWorkDiscussion({ ...artifact, threadId: '' }, '@codex61-sol ', failure)).toBe(false);
  expect(queueWorkDiscussion({ ...artifact, sourceMessageId: null }, '@codex61-sol ', failure)).toBe(false);
  expect(queueWorkDiscussion({ ...artifact, catId: null }, '@codex61-sol ', failure)).toBe(false);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});
