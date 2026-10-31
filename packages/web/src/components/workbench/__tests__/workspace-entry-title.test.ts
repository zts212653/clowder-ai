import { expect, it } from 'vitest';
import type { ChatMessage, WorkspaceOpenRequest } from '@/stores/chat-types';
import { workspaceEntryTitle } from '../workspace-entry-title';

const timestamp = Date.UTC(2026, 9, 6, 18, 42);
const message: ChatMessage = {
  id: 'original-image',
  type: 'assistant',
  catId: 'codex-sol',
  content: 'image',
  timestamp,
};
const target: WorkspaceOpenRequest['target'] = {
  kind: 'message-publication',
  title: 'generated image',
  source: {
    kind: 'message',
    threadId: 'original-thread',
    messageId: message.id,
    messageRevision: '1',
    expectedUrl: '/uploads/original.png',
    item: { kind: 'content-block', index: 0 },
  },
};
const caption = (input: WorkspaceOpenRequest['target'], messages: ChatMessage[]) =>
  workspaceEntryTitle(input, messages, (id) => (id === 'codex-sol' ? '小太阳' : 'another cat'), '图片');
it('uses the original sender and timestamp for a generic image name', () => {
  const clock = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  expect(caption(target, [message])).toBe(`图片 · 小太阳 ${clock}`);
});
it('keeps a meaningful user title', () => expect(caption({ ...target, title: '晨光' }, [message])).toBeNull());
it('does not borrow a different message sender or time when the original source is unavailable', () =>
  expect(caption(target, [{ ...message, id: 'another-image' }])).toBeNull());
it('does not invent a timestamp or a sender', () => {
  expect(caption(target, [{ ...message, catId: undefined }])).toBeNull();
  expect(caption(target, [{ ...message, timestamp: Number.NaN }])).toBeNull();
});
