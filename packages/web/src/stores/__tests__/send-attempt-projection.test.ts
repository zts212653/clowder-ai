import { expect, it } from 'vitest';
import { isMessageSelectableForBundle } from '@/components/message-selection';
import { findChatReadingSuccessor, resolveChatReadingAnchor } from '@/utils/chat-scroll-memory';
import type { SendAttempt } from '@/utils/send-attempt-db';
import type { ChatMessage, QueueEntry } from '../chat-types';
import { withSendAttempts } from '../send-attempt-projection';

const attempt: SendAttempt = {
  id: 'client-key',
  ownerUserId: 'owner',
  threadId: 'thread',
  content: 'keep this input',
  files: [],
  timestamp: 10,
  status: 'sending',
};
const queue: QueueEntry = {
  id: 'queue:server-id',
  clientMessageId: attempt.id,
  messageId: 'server-id',
  threadId: 'thread',
  userId: 'owner',
  content: attempt.content,
  from: { kind: 'user', userId: 'owner' },
  mergedMessageIds: [],
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: 20,
};

it('shows the attempt without a Queue or History, retaining it when Queue becomes empty', () => {
  expect(withSendAttempts([], [attempt], 'thread')).toMatchObject([
    { content: attempt.content, sendAttempt: { status: 'sending' } },
  ]);
  expect(
    withSendAttempts([], [{ ...attempt, status: 'accepted', serverMessageId: 'server-id' }], 'thread'),
  ).toHaveLength(1);
  expect(withSendAttempts([], [attempt], 'other-thread')).toEqual([]);
});
it('merges a Queue event that arrives before HTTP, then hands off to exact History without a duplicate', () => {
  const preview: ChatMessage = {
    id: 'server-id',
    clientMessageId: attempt.id,
    type: 'user',
    content: attempt.content,
    queuedEntryId: queue.id,
    timestamp: 20,
  };
  expect(withSendAttempts([preview], [attempt], 'thread', [queue])).toHaveLength(1);
  expect(
    withSendAttempts([preview], [{ ...attempt, status: 'canceled' }], 'thread', [queue])[0]?.sendAttempt?.status,
  ).toBe('canceled');
  const canonical = { ...preview, queuedEntryId: undefined, deliveredAt: 30 };
  const settled = withSendAttempts([canonical], [attempt], 'thread');
  expect(settled).toHaveLength(1);
  expect(settled[0]?.sendAttempt).toBeUndefined();
  expect(settled[0]?.id).toBe('server-id');
  expect(canonical).not.toHaveProperty('sendAttempt');
});
it('never merges two intentional identical sends by their text', () => {
  expect(withSendAttempts([], [attempt, { ...attempt, id: 'another-key' }], 'thread')).toHaveLength(2);
});
it('does not turn local attempts into a reading checkpoint or a selectable History source', () => {
  const local = withSendAttempts([], [attempt], 'thread')[0]!;
  expect(isMessageSelectableForBundle(local)).toBe(false);
  expect(resolveChatReadingAnchor({ messageId: local.id, viewportOffsetPx: 0 }, [local])).toBeUndefined();
  expect(
    findChatReadingSuccessor({ messageId: 'older', viewportOffsetPx: 0, timelineOrderAt: 0 }, [local]),
  ).toBeUndefined();
});
