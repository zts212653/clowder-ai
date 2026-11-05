import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { LiveInboxScope } from '../src/domains/concierge/live/inbox/live-inbox-contract.js';
import { MessageLiveInboxSource } from '../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.js';

const target = createCatId('codex-astra');
const scope: LiveInboxScope = {
  userId: 'owner',
  threadId: 'home',
  catId: target,
  invocationId: 'live-child',
  parentInvocationId: 'live-parent',
  callId: 'live',
  generation: 1,
};
async function append(store: MessageStore, queue: InvocationQueue, index = 1) {
  const from = { kind: 'agent' as const, catId: createCatId('opus') };
  const content = `private-body-${index}`;
  const result = await queue.send(
    store,
    {
      userId: scope.userId,
      threadId: scope.threadId,
      from,
      content,
      mentions: [target],
      timestamp: index,
      deliveryStatus: 'queued',
      extra: { crossPost: { sourceThreadId: `source-${index % 10}`, effectClass: 'coordinate' } },
    },
    {
      kind: 'conversation_input',
      threadId: scope.threadId,
      userId: scope.userId,
      from,
      ownerAuthProvenance: 'strict',
      content,
      targetCats: [target],
      intent: 'coordinate',
      authorIntentByCatId: { [target]: { requested: 'continue_current', boundParentInvocationId: 'live-parent' } },
    },
  );
  assert.ok(result.message && result.entry);
  return result.message;
}
function deliveredFixture() {
  const f = createPersistedQueueFixture();
  const source = new MessageLiveInboxSource({ store: f.messages, queue: f.queue, authorize: async () => true });
  async function deliver() {
    const result = await f.delivery.deliver({
      ownerUserId: scope.userId,
      threadId: scope.threadId,
      targetCatId: target,
      idempotencyKey: 'inbox-source',
      content: 'private-body-delivered',
      from: { kind: 'external', connectorId: 'test' },
      ownerAuthProvenance: 'strict',
      source: { connector: 'test', label: 'inbox-source' },
    });
    assert.ok(result.message);
    return { message: result.message, invocationId: await f.waitForAwakening(result.message.id) };
  }
  return { ...f, source, deliver };
}

test('Message source pages >100 canonical Queue sources without exposing bodies or writing receipts', async () => {
  const store = new MessageStore();
  const queue = new InvocationQueue();
  const original = [];
  for (let index = 0; index < 237; index++) original.push(await append(store, queue, index));
  const source = new MessageLiveInboxSource({ store, queue, authorize: async () => true });
  let cursor: string | undefined;
  const found: string[] = [];
  for (let page = 0; page < 10; page++) {
    const result = await source.page(scope, cursor, 50);
    assert.equal(JSON.stringify(result).includes('private-body'), false);
    found.push(...result.items.map((item) => item.messageId));
    if (!result.hasMore) break;
    assert.notEqual(result.nextCursor, cursor);
    cursor = result.nextCursor;
  }
  assert.deepEqual(
    found,
    original.map((message) => message.id),
  );
  assert.ok(original.every((message) => !Object.hasOwn(message, 'queueCustody')));
  assert.equal(queue.list(scope.threadId, scope.userId).length, 237);
});

test('exact History delivery does not fabricate native read, notification or retained context evidence', async (t) => {
  const f = deliveredFixture();
  t.after(() => f.close());
  const { message } = await f.deliver();
  const ref = await f.source.read(scope, message.id);
  assert.deepEqual(ref?.facts, {
    persisted: true,
    notified: false,
    readByInvocationIds: [],
    readInCurrentContext: false,
    handled: false,
    playback: 'unknown',
  });
  assert.equal(f.queue.list(scope.threadId, scope.userId).length, 0, 'delivery already retired the pending target');
  await f.close();
  assert.equal(
    (await f.source.read(scope, message.id))?.facts.handled,
    true,
    'terminal belongs to the exact original response',
  );
});

test('permission, owner/thread/target, recall, cancellation and whisper boundaries are rechecked', async () => {
  const store = new MessageStore();
  const queue = new InvocationQueue();
  let allowed = true;
  const source = new MessageLiveInboxSource({ store, queue, authorize: async () => allowed });
  const message = await append(store, queue);
  assert.ok(await source.read(scope, message.id));
  allowed = false;
  await assert.rejects(source.read(scope, message.id), { name: 'LiveInboxAuthorityUnavailableError' });
  await assert.rejects(source.page(scope, undefined, 10), { name: 'LiveInboxAuthorityUnavailableError' });
  allowed = true;
  assert.equal(await source.read({ ...scope, userId: 'other' }, message.id), null);
  assert.equal(await source.read({ ...scope, threadId: 'other' }, message.id), null);
  assert.equal(await source.read({ ...scope, catId: createCatId('kimi') }, message.id), null);
  message.visibility = 'whisper';
  message.whisperTo = [createCatId('kimi')];
  assert.equal(await source.read(scope, message.id), null);
  message.visibility = 'public';
  message.recall = { version: 1, exposure: 'none', recalledAt: 20 };
  assert.equal(await source.read(scope, message.id), null);
  delete message.recall;
  store.markCanceled(message.id);
  assert.equal(await source.read(scope, message.id), null);
});
