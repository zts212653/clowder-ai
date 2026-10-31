import { type ContextAttachment, ContextAttachmentsSchema, type QuoteContextAttachment } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { composerAttachments } from '@/components/composer-queue';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { editWorkspaceFileQuoteInChat, workspaceFileQuoteAttachment } from '../workspace-file-quote';

const THREAD = 'file-quote-edit';
const initial = useChatStore.getState();
const quote = (text: string, comment = `${text} comment`): QuoteContextAttachment => {
  const attachment = workspaceFileQuoteAttachment({
    text,
    comment,
    path: 'docs/a.md',
    worktreeId: 'wt-a',
    revision: 'a'.repeat(64),
    lineStart: 2,
    lineEnd: 2,
    selectionStart: 4,
    selectionEnd: 9,
  });
  if (attachment.kind !== 'quote') throw new Error('quote fixture expected');
  return attachment;
};
const other: ContextAttachment = { v: 1, kind: 'thread', id: 'other', threadId: 'other-thread', title: 'Kept' };

beforeEach(() => {
  useChatStore.setState({ currentThreadId: THREAD, pendingChatInsert: null });
  useToastStore.setState({ toasts: [] });
  syncContextAttachmentDraftToStorage(THREAD, []);
});
afterEach(() => {
  useChatStore.setState(initial, true);
  syncContextAttachmentDraftToStorage(THREAD, []);
});

it.each(['edit', 'delete'] as const)('%s preserves the stored and queued draft around the original id', (action) => {
  const original = quote('original');
  const second = quote('second');
  syncContextAttachmentDraftToStorage(THREAD, [original, other]);
  useChatStore.getState().setPendingChatInsert({
    threadId: THREAD,
    text: '未发送草稿\nsecond line',
    contextAttachments: [second],
    removeContextAttachmentIds: ['already-removed'],
  });
  expect(editWorkspaceFileQuoteInChat(THREAD, original, action === 'edit' ? '新说明\nmixed' : null)).toBe(true);
  expect(composerAttachments(THREAD)).toEqual(
    action === 'edit' ? [{ ...original, comment: '新说明\nmixed' }, other, second] : [other, second],
  );
  expect(useChatStore.getState().pendingChatInsert).toMatchObject({
    text: '未发送草稿\nsecond line',
    removeContextAttachmentIds: ['already-removed', original.id],
  });
  // The normal composer consumes this delta and persists it; the file view does not bypass that owner.
  expect(getContextAttachmentDraft(THREAD)).toEqual([original, other]);
});

it('editing an unconsumed first quote retains its position and the second quote', () => {
  const first = quote('first');
  const second = quote('second');
  useChatStore.getState().setPendingChatInsert({ threadId: THREAD, text: 'keep', contextAttachments: [first, second] });
  expect(editWorkspaceFileQuoteInChat(THREAD, first, 'changed')).toBe(true);
  expect(composerAttachments(THREAD)).toEqual([{ ...first, comment: 'changed' }, second]);
});

it('refuses an edit that would push the whole input past one message, tells the person, and queues nothing', () => {
  const first = quote('a'.repeat(20_000), 'first comment');
  const second = quote('b'.repeat(20_000), 'second comment');
  syncContextAttachmentDraftToStorage(THREAD, [first, second]);
  expect(ContextAttachmentsSchema.safeParse(composerAttachments(THREAD)).success).toBe(true);

  expect(editWorkspaceFileQuoteInChat(THREAD, first, 'x'.repeat(9_000))).toBe(false);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(useToastStore.getState().toasts[0]?.message).toContain('请先发送或移除几个');
  expect(composerAttachments(THREAD)).toEqual([first, second]);
  expect(getContextAttachmentDraft(THREAD)).toEqual([first, second]);
});

it.each(['authoritative', 'serverRevision'] as const)('does not overwrite a pending %s recall answer', (field) => {
  const original = quote('original');
  syncContextAttachmentDraftToStorage(THREAD, [original]);
  const recalled = { threadId: THREAD, text: 'recalled', [field]: field === 'authoritative' ? true : 2 };
  useChatStore.getState().setPendingChatInsert(recalled);
  expect(editWorkspaceFileQuoteInChat(THREAD, original, 'changed')).toBe(false);
  expect(editWorkspaceFileQuoteInChat(THREAD, original, null)).toBe(false);
  expect(useChatStore.getState().pendingChatInsert).toBe(recalled);
});

it.each(['thread', 'source', 'removed'] as const)('refuses an editor that outlived its %s', (change) => {
  const original = quote('original');
  syncContextAttachmentDraftToStorage(THREAD, [original]);
  if (change === 'thread') useChatStore.setState({ currentThreadId: 'another-thread' });
  if (change === 'source') {
    if (original.source.kind !== 'workspace_file') throw new Error('workspace source fixture expected');
    syncContextAttachmentDraftToStorage(THREAD, [
      { ...original, source: { ...original.source, revision: `sha256:${'b'.repeat(64)}` } },
    ]);
  }
  if (change === 'removed') syncContextAttachmentDraftToStorage(THREAD, []);
  expect(editWorkspaceFileQuoteInChat(THREAD, original, 'changed')).toBe(false);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});
