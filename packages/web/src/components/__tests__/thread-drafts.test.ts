// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

const load = () => import('../thread-drafts');
const quote = { v: 1 as const, id: 'ctx-a', kind: 'thread' as const, threadId: 'source', title: 'Source' };

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it('keeps one draft per conversation: text, quoted reply and places', async () => {
  const drafts = await load();
  drafts.syncDraftToStorage('thread-a', 'words for A');
  drafts.syncDraftToStorage('thread-b', 'words for B');
  drafts.syncReplyDraftToStorage('thread-a', { id: 'm-1', content: 'parent', senderCatId: null, threadId: 'thread-a' });
  drafts.syncContextAttachmentDraftToStorage('thread-b', [quote]);
  expect(drafts.getThreadDraft('thread-a')).toBe('words for A');
  expect(drafts.getThreadDraft('thread-b')).toBe('words for B');
  expect(drafts.threadReplyDrafts.get('thread-a')?.id).toBe('m-1');
  expect(drafts.threadReplyDrafts.has('thread-b')).toBe(false);
  expect(drafts.getContextAttachmentDraft('thread-b')).toEqual([quote]);
  expect(drafts.getContextAttachmentDraft('thread-a')).toEqual([]);
});

it('survives a reload from browser storage', async () => {
  const before = await load();
  before.syncDraftToStorage('thread-a', 'unsent words');
  before.syncReplyDraftToStorage('thread-a', { id: 'm-1', content: 'parent', senderCatId: null, threadId: 'thread-a' });
  before.syncContextAttachmentDraftToStorage('thread-a', [quote]);
  vi.resetModules();
  const after = await load();
  expect(after.getThreadDraft('thread-a')).toBe('unsent words');
  expect(after.threadReplyDrafts.get('thread-a')?.id).toBe('m-1');
  expect(after.getContextAttachmentDraft('thread-a')).toEqual([quote]);
  expect(after.hasPendingThreadDraft('thread-a')).toBe(true);
});

it('is cleared when the sent input writes its empty state', async () => {
  const drafts = await load();
  const changed = vi.fn();
  drafts.subscribeThreadDrafts(changed);
  drafts.syncDraftToStorage('thread-a', 'about to send');
  drafts.syncReplyDraftToStorage('thread-a', { id: 'm-1', content: 'parent', senderCatId: null, threadId: 'thread-a' });
  drafts.syncContextAttachmentDraftToStorage('thread-a', [quote]);
  drafts.syncDraftToStorage('thread-a', '');
  drafts.syncReplyDraftToStorage('thread-a', null);
  drafts.syncContextAttachmentDraftToStorage('thread-a', []);
  expect(drafts.hasPendingThreadDraft('thread-a')).toBe(false);
  expect(localStorage.getItem('cat-cafe:thread-drafts')).toBeNull();
  expect(localStorage.getItem('cat-cafe:thread-reply-drafts')).toBeNull();
  expect(localStorage.getItem('cat-cafe:thread-context-attachment-drafts')).toBeNull();
  expect(changed).toHaveBeenCalledTimes(4);
});
