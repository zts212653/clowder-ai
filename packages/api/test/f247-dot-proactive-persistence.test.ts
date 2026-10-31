import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId, dotAskMetadataSchema } from '@cat-cafe/shared';
import { MessageStore, mergeMessageExtra } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra } from '../src/domains/cats/services/stores/redis/redis-message-parsers.js';

const metadata = {
  v: 1 as const,
  ownerUserId: 'owner',
  attemptId: 'attempt',
  subscriptionId: 'subscription',
  recipientCatIds: ['codex'],
  requestKey: 'request',
  requestDigest: '1'.repeat(64),
};

test('canonical dot request admission survives Redis hydration and cannot be rewritten through generic extra patches', () => {
  const messages = new MessageStore();
  const root = messages.append({
    userId: 'owner',
    threadId: 'A',
    from: { kind: 'agent', catId: createCatId('gpt-dot') },
    content: 'question',
    mentions: [createCatId('codex')],
    timestamp: 100,
    extra: { dotAsk: metadata },
    idempotencyKey: 'request',
  });
  const hydrated = safeParseExtra(JSON.stringify(root.extra));
  assert.deepEqual(hydrated?.dotAsk, metadata);
  assert.deepEqual(messages.getByIdempotencyKey('owner', 'dot-ask:attempt', 'request'), root);
  assert.equal(messages.getByIdempotencyKey('owner', 'A', 'request'), null);
  const retry = messages.appendIdempotent({
    ...root,
    threadId: 'B',
    extra: { dotAsk: metadata },
    idempotencyKey: 'request',
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.message.id, root.id, 'one owner/attempt key cannot create another thread root');
  assert.deepEqual(
    mergeMessageExtra(root.extra, { dotAsk: { ...metadata, subscriptionId: 'forged' } })?.dotAsk,
    metadata,
  );
  const patch = { dotAsk: { ...metadata, subscriptionId: 'forged' } };
  messages.updateExtra(root.id, patch as never);
  assert.deepEqual(messages.getById(root.id)?.extra?.dotAsk, metadata);
  assert.equal(safeParseExtra(JSON.stringify({ dotAsk: { ...metadata, v: 2 } })), undefined);
  assert.equal(dotAskMetadataSchema.safeParse({ ...metadata, arbitrary: true }).success, false);
});
