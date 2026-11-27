// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const load = async () => {
  const { observeApiSessionOwner } = await import('@/utils/api-session-identity');
  observeApiSessionOwner('test-owner');
  return import('../thread-drafts');
};
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
  expect(localStorage.getItem('cat-cafe:thread-drafts:test-owner')).toBeNull();
  expect(localStorage.getItem('cat-cafe:thread-reply-drafts:test-owner')).toBeNull();
  expect(localStorage.getItem('cat-cafe:thread-context-attachment-drafts:test-owner')).toBeNull();
  expect(changed).toHaveBeenCalledTimes(4);
});

it('keeps draft text, attachments and replies separate on account switches and returns', async () => {
  const drafts = await load();
  const { observeApiSessionOwner } = await import('@/utils/api-session-identity');
  const file = new File(['first'], 'first.txt');
  drafts.syncDraftToStorage('thread-a', 'first owner text');
  drafts.syncReplyDraftToStorage('thread-a', {
    id: 'old',
    content: 'first reply',
    senderCatId: null,
    threadId: 'thread-a',
  });
  drafts.syncContextAttachmentDraftToStorage('thread-a', [quote]);
  drafts.threadImageDrafts.set('thread-a', [file]);

  observeApiSessionOwner('second');
  expect(drafts.getThreadDraft('thread-a')).toBe('');
  expect(drafts.getContextAttachmentDraft('thread-a')).toEqual([]);
  expect(drafts.threadReplyDrafts.get('thread-a')).toBeUndefined();
  expect(drafts.threadImageDrafts.get('thread-a')).toBeUndefined();
  drafts.syncDraftToStorage('thread-a', 'second owner text');

  observeApiSessionOwner('test-owner');
  expect(drafts.getThreadDraft('thread-a')).toBe('first owner text');
  expect(drafts.getContextAttachmentDraft('thread-a')).toEqual([quote]);
  expect(drafts.threadReplyDrafts.get('thread-a')?.id).toBe('old');
  expect(drafts.threadImageDrafts.get('thread-a')).toEqual([file]);
});

it('offers legacy records for explicit recovery while keeping the account maps and old keys untouched', async () => {
  const threadId = 'thread-a';
  const reply = { id: 'm-1', content: 'parent', senderCatId: null, threadId };
  const legacy = {
    'cat-cafe:thread-drafts': [[threadId, 'unsent offline words']],
    'cat-cafe:thread-reply-drafts': [[threadId, reply]],
    'cat-cafe:thread-context-attachment-drafts': [[threadId, [quote]]],
  };
  Object.entries(legacy).forEach(([key, value]) => localStorage.setItem(key, JSON.stringify(value)));
  const drafts = await load();
  const { apiSessionIdentity, observeApiSessionOwner } = await import('@/utils/api-session-identity');
  const { apiFetch } = await import('@/utils/api-client');
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json({ id: path === '/api/threads/default' ? 'default' : threadId, createdBy: 'test-owner' }),
  );
  expect(drafts.hasLegacyThreadDraft(threadId)).toBe(true);
  expect(drafts.hasPendingThreadDraft(threadId)).toBe(false);
  const owner = apiSessionIdentity.getSnapshot();
  expect(await drafts.readVerifiedLegacyThreadDraft(threadId, owner)).toEqual({
    text: 'unsent offline words',
    contexts: [quote],
    reply,
  });

  observeApiSessionOwner('second');
  expect(await drafts.readVerifiedLegacyThreadDraft(threadId, owner)).toBeUndefined();
  expect(await drafts.readVerifiedLegacyThreadDraft(threadId, apiSessionIdentity.getSnapshot())).toBeUndefined();
  expect(drafts.hasPendingThreadDraft(threadId)).toBe(false);
  Object.entries(legacy).forEach(([key, value]) => expect(localStorage.getItem(key)).toBe(JSON.stringify(value)));
});
