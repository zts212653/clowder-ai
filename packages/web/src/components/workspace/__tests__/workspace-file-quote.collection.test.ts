import { type ContextAttachment, ContextAttachmentsSchema } from '@cat-cafe/shared';
import { beforeEach, expect, it } from 'vitest';
import { composerAttachments } from '@/components/content-review/media-chat-composer';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { addWorkspaceFileQuoteToChat } from '../workspace-file-quote';

const threadId = 'review-pr5134';
const revision = `sha256:${'a'.repeat(64)}`;
const quote = { text: 'new selected place', comment: 'revise', path: 'notes.md', worktreeId: 'wt', revision };
const reference = (i: number): ContextAttachment => ({
  v: 1,
  kind: 'thread',
  id: `t-${i}`,
  threadId: `ref-${i}`,
  title: 'kept',
});
beforeEach(() => {
  useChatStore.setState({ pendingChatInsert: null });
  syncContextAttachmentDraftToStorage(threadId, []);
});

it('adds a thirteenth reference without losing the twelve queued references or their text', () => {
  const queued = Array.from({ length: 12 }, (_, i) => reference(i));
  expect(ContextAttachmentsSchema.safeParse(queued).success).toBe(true);
  useChatStore.setState({ pendingChatInsert: { threadId, text: 'keep these words', contextAttachments: queued } });
  expect(addWorkspaceFileQuoteToChat(threadId, quote)).toEqual({ kind: 'added' });
  const next = composerAttachments(threadId);
  expect(
    ContextAttachmentsSchema.safeParse(next).success,
    'the real queued replacement must still be a legal composer',
  ).toBe(true);
  expect(next).toHaveLength(13);
  expect(next.slice(0, 12)).toEqual(queued);
  expect(next[12]).toMatchObject({
    kind: 'quote',
    text: quote.text,
    comment: quote.comment,
    source: { kind: 'workspace_file', path: quote.path, worktreeId: quote.worktreeId, revision: quote.revision },
  });
  expect(useChatStore.getState().pendingChatInsert?.text).toBe('keep these words');
});

it('persists the new quote alongside twelve references already in the real saved draft', () => {
  const saved = Array.from({ length: 12 }, (_, i) => reference(i));
  syncContextAttachmentDraftToStorage(threadId, saved);
  expect(getContextAttachmentDraft(threadId)).toEqual(saved);
  expect(addWorkspaceFileQuoteToChat(threadId, quote)).toEqual({ kind: 'added' });
  const next = composerAttachments(threadId);
  syncContextAttachmentDraftToStorage(threadId, next);
  expect(getContextAttachmentDraft(threadId), 'the real writer must not lose the earlier references').toEqual(next);
  expect(next).toHaveLength(13);
  expect(next.slice(0, 12)).toEqual(saved);
  expect(next[12]).toMatchObject({ kind: 'quote', text: quote.text, comment: quote.comment });
});

it('preserves the saved collection when prompt escaping puts the next quote past the canonical size bound', () => {
  const saved: ContextAttachment[] = [
    {
      v: 1,
      id: 'large-but-legal',
      kind: 'quote',
      text: '<'.repeat(7900),
      source: { kind: 'message', threadId: 't', messageId: 'm' },
    },
  ];
  expect(ContextAttachmentsSchema.safeParse(saved).success, 'the old reference alone is valid').toBe(true);
  syncContextAttachmentDraftToStorage(threadId, saved);
  addWorkspaceFileQuoteToChat(threadId, { ...quote, comment: 'x'.repeat(2000) });
  const next = composerAttachments(threadId);
  expect(
    ContextAttachmentsSchema.safeParse(next).success,
    'validate the canonical full collection, including escaped prompt',
  ).toBe(true);
  syncContextAttachmentDraftToStorage(threadId, next);
  expect(getContextAttachmentDraft(threadId)).toEqual(saved);
});
it('refuses a file quote after a frozen screening mark before it can create an ambiguous source', () => {
  const saved: ContextAttachment = {
    v: 1,
    kind: 'project-screening',
    id: 'film',
    title: '原成片',
    contentRef: 'project-1',
    screeningId: 'screening-1',
    input: { contentRef: 'project-1', ownerRevision: 1, blobDigest: revision },
    media: { contentRef: 'media-1', ownerRevision: 1, blobDigest: revision },
    selections: [{ id: 'place', mediaRange: { startPts: 0, endPts: 1 }, target: { kind: 'project' } }],
  };
  syncContextAttachmentDraftToStorage(threadId, [saved]);
  expect(addWorkspaceFileQuoteToChat(threadId, quote)).toMatchObject({ kind: 'refused', reason: 'other_source' });
  expect(composerAttachments(threadId)).toEqual([saved]);
  expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/发送|移除/);
});
