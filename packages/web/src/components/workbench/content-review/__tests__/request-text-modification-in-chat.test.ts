import { afterEach, beforeEach, expect, it } from 'vitest';
import { addWorkspaceFileQuoteToChat } from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';
import { requestTextModificationInChat } from '../request-text-modification-in-chat';

const thread = 'doc-request-test';
const locator = { worktreeId: 'worktree-doc', path: 'book.md' };
const revision = `sha256:${'a'.repeat(64)}`;
const request = { content: 'first quote\nsecond quote', revision };
const anchor = {
  kind: 'text_quote',
  baseRevision: revision,
  start: 0,
  end: 11,
  quote: 'first quote',
  quoteDigest: revision,
  contextDigest: revision,
};
const initial = useChatStore.getState();
beforeEach(() => useChatStore.setState({ currentThreadId: thread, pendingChatInsert: null }));
afterEach(() => useChatStore.setState(initial, true));

it.each([
  ['missing', undefined],
  ['malformed', {}],
  ['other version', { ...anchor, baseRevision: `sha256:${'e'.repeat(64)}` }],
  ['different words', { ...anchor, quote: 'wrong quote' }],
  ['outside the displayed source', { ...anchor, end: 100 }],
])('refuses a %s selection answer instead of choosing a different scope', (_label, selection) => {
  expect(requestTextModificationInChat(thread, locator, request, selection, 'first quote')).toBe('refused');
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});

it('refuses an answer for another selected place even in the same file', () => {
  expect(requestTextModificationInChat(thread, locator, request, anchor, 'second quote')).toBe('refused');
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});

it('reuses the same place and focuses the original composer without changing its comment, draft or caret', () => {
  useChatStore.setState({ pendingChatInsert: { threadId: thread, text: 'original words' } });
  addWorkspaceFileQuoteToChat(thread, {
    ...locator,
    revision,
    text: anchor.quote,
    comment: 'original comment',
    selectionStart: 0,
    selectionEnd: 11,
  });
  const before = useChatStore.getState().pendingChatInsert;
  const host = document.createElement('div');
  host.dataset.guideId = 'chat.input';
  const input = document.createElement('textarea');
  input.value = 'original words';
  host.append(input);
  document.body.append(host);
  input.setSelectionRange(3, 8);
  try {
    expect(requestTextModificationInChat(thread, locator, request, anchor, 'first quote')).toBe('existing');
    expect(useChatStore.getState().pendingChatInsert).toBe(before);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('original words');
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8]);
  } finally {
    host.remove();
  }
});

it('a recall acknowledgement keeps custody of the queued slot', () => {
  const before = { threadId: thread, text: 'server answer', authoritative: true, serverRevision: 4 };
  useChatStore.setState({ pendingChatInsert: before });
  expect(requestTextModificationInChat(thread, locator, request, anchor, 'first quote')).toBe('recall_pending');
  expect(useChatStore.getState().pendingChatInsert).toBe(before);
});

it('another conversation cannot receive the selected file place', () => {
  useChatStore.setState({ currentThreadId: 'another-thread' });
  expect(requestTextModificationInChat(thread, locator, request, anchor, 'first quote')).toBe('no_thread');
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});

it('a unique place already queued without raw offsets keeps its original ID and comment', () => {
  addWorkspaceFileQuoteToChat(thread, { ...locator, revision, text: 'first quote', comment: 'keep this comment' });
  const before = useChatStore.getState().pendingChatInsert;
  expect(requestTextModificationInChat(thread, locator, request, anchor, 'first quote')).toBe('existing');
  expect(useChatStore.getState().pendingChatInsert).toBe(before);
});

it('repeated words without exact offsets are not silently treated as the same selected place', () => {
  const repeated = { content: 'first quote\nfirst quote', revision };
  addWorkspaceFileQuoteToChat(thread, { ...locator, revision, text: 'first quote', comment: 'unknown place' });
  const original = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  const second = { ...anchor, start: 12, end: 23 };
  expect(requestTextModificationInChat(thread, locator, repeated, second, 'first quote')).toBe('added');
  const places = useChatStore.getState().pendingChatInsert?.contextAttachments;
  expect(places).toHaveLength(2);
  expect(places?.[0]).toEqual(original);
  expect(places?.[1].id).not.toBe(original?.id);
});
