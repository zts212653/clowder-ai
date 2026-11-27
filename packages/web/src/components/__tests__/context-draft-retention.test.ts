// @vitest-environment jsdom
import type { ContextAttachment } from '@cat-cafe/shared';
import { afterEach, expect, it } from 'vitest';
import {
  getContextAttachmentDraft,
  parseContextAttachmentDrafts,
  syncContextAttachmentDraftToStorage,
  threadContextAttachmentDrafts,
} from '../thread-drafts';

const thread = 'comment-retention';
const key = 'cat-cafe:thread-context-attachment-drafts';
function comments(count: number, text = 'quoted text'): ContextAttachment[] {
  return Array.from({ length: count }, (_, index) => ({
    v: 1,
    id: `quote-${index}`,
    kind: 'quote',
    text,
    comment: `comment ${index + 1}`,
    source: { kind: 'message', threadId: 'source', messageId: `message-${index}` },
  }));
}
afterEach(() => {
  threadContextAttachmentDrafts.clear();
  localStorage.clear();
});

it('retains all fifteen comments through a browser-storage round trip', () => {
  const draft = comments(15);
  syncContextAttachmentDraftToStorage(thread, draft);
  expect(getContextAttachmentDraft(thread)).toEqual(draft);
  expect(parseContextAttachmentDrafts(localStorage.getItem(key)).get(thread)).toEqual(draft);
});

it('keeps a structurally valid draft even when it is too large to send', () => {
  const draft = comments(3, 'x'.repeat(17_000));
  syncContextAttachmentDraftToStorage(thread, draft);
  expect(getContextAttachmentDraft(thread)).toEqual(draft);
  expect(parseContextAttachmentDrafts(localStorage.getItem(key)).get(thread)).toEqual(draft);
});

it('does not reinterpret invalid input as an explicit draft deletion', () => {
  const saved = comments(1);
  syncContextAttachmentDraftToStorage(thread, saved);
  const before = localStorage.getItem(key);
  syncContextAttachmentDraftToStorage(thread, [{ ...saved[0], v: 2 }] as unknown as ContextAttachment[]);
  expect(getContextAttachmentDraft(thread)).toEqual(saved);
  expect(localStorage.getItem(key)).toBe(before);
  syncContextAttachmentDraftToStorage(thread, []);
  expect(getContextAttachmentDraft(thread)).toEqual([]);
  expect(localStorage.getItem(key)).toBeNull();
});
