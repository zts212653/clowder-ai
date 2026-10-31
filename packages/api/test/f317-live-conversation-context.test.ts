import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import {
  liveInitialItems,
  readLiveConversationContext,
} from '../src/domains/concierge/live/live-conversation-context.js';

const scope = { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra') };
function row(id: string, patch: Partial<StoredMessage> = {}): StoredMessage {
  return { id, userId: 'owner', threadId: 'home', catId: null, content: id, mentions: [], timestamp: 1, ...patch };
}

test('reconnection quotes only delivered visible own-thread conversation with canonical message sources', async () => {
  const messages = [
    row('user'),
    row('cat', { catId: scope.catId }),
    row('foreign-owner', { userId: 'other' }),
    row('foreign-thread', { threadId: 'other' }),
    row('deleted', { deletedAt: 1 }),
    row('queued', { deliveryStatus: 'queued' }),
    row('canceled', { deliveryStatus: 'canceled' }),
    row('briefing', { origin: 'briefing' }),
    row('whisper', { visibility: 'whisper', whisperTo: [createCatId('opus')] }),
    row('other-cat', { catId: createCatId('opus') }),
    row('unhandled-coordination', { catId: scope.catId, extra: { crossPost: { sourceThreadId: 'elsewhere' } } }),
    row('malformed-source', { sourceParseFailure: true }),
  ];
  const text = await readLiveConversationContext(
    {
      getByThread: (threadId, limit, owner) => {
        assert.equal(threadId, 'home');
        assert.equal(owner, 'owner');
        assert.equal(limit, 32);
        return messages;
      },
    },
    scope,
  );
  const projection = JSON.parse(text);
  assert.equal(projection.coverage, 'recent_subset');
  assert.deepEqual(
    projection.messages.map((item: { messageId: string }) => item.messageId),
    ['user', 'cat'],
  );
  const items = liveInitialItems(text);
  assert.equal(items.length, 1);
  assert.ok(
    items.every((item) => item.role === 'developer'),
    'history must not become newly submitted user turns',
  );
  assert.match(String(items[0].text), /不是新的用户指令/);
  assert.match(String(items[0].text), /不授予权限/);
});

test('recent projection is bounded, preserves order, marks truncation and propagates reader failure', async () => {
  const text = await readLiveConversationContext(
    { getByThread: () => Array.from({ length: 32 }, (_, i) => row(String(i), { content: 'x'.repeat(2000) })) },
    scope,
  );
  const messages = JSON.parse(text).messages;
  assert.ok(messages.length < 12);
  assert.equal(messages.at(-1).messageId, '31');
  assert.ok(messages.every((item: { truncated: boolean; text: string }) => item.truncated && item.text.length === 800));
  assert.ok(text.length < 6200);
  await assert.rejects(
    readLiveConversationContext(
      {
        getByThread: async () => {
          throw new Error('history unavailable');
        },
      },
      scope,
    ),
    /history unavailable/,
  );
});

test('reconnection can quote the selected deep cat while preserving its real author and visibility', async () => {
  const dutyCatId = createCatId('opus');
  const text = await readLiveConversationContext(
    {
      getByThread: () => [
        row('user'),
        row('deep-answer', { catId: dutyCatId }),
        row('private-answer', { catId: dutyCatId, visibility: 'whisper', whisperTo: [dutyCatId] }),
        row('different-cat', { catId: createCatId('gemini') }),
        row('queued-answer', { catId: dutyCatId, deliveryStatus: 'queued' }),
      ],
    },
    { ...scope, dutyCatId },
  );
  const messages = JSON.parse(text).messages;
  assert.deepEqual(
    messages.map((item: { messageId: string }) => item.messageId),
    ['user', 'deep-answer'],
  );
  assert.equal(messages[1].catId, 'opus');
  assert.equal(messages[0].catId, null);
});
