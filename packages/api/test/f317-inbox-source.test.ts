import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { QueuedMessageCustody } from '../src/domains/cats/services/stores/ports/queued-message-custody.js';
import { LiveInbox } from '../src/domains/concierge/live/inbox/LiveInbox.js';
import type { LiveInboxScope } from '../src/domains/concierge/live/inbox/live-inbox-contract.js';
import { MessageLiveInboxSource } from '../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';

const target = createCatId('codex-astra');
const scope: LiveInboxScope = {
  userId: 'owner',
  threadId: 'home',
  catId: target,
  invocationId: 'live-child',
  callId: 'live',
  generation: 1,
};
function custody(overrides: Partial<QueuedMessageCustody> = {}): QueuedMessageCustody {
  return {
    version: 1,
    entryId: 'entry',
    revision: 1,
    intent: 'coordinate',
    status: 'queued',
    allTargetCats: [target],
    pendingTargetCats: [target],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}
function append(store: MessageStore, index = 1, queue = custody()) {
  return store.append({
    userId: 'owner',
    threadId: 'home',
    catId: createCatId('opus'),
    content: `private-body-${index}`,
    mentions: [target],
    timestamp: index,
    deliveryStatus: 'queued',
    queueCustody: queue,
    extra: { crossPost: { sourceThreadId: `source-${index % 10}`, effectClass: 'coordinate' } },
  });
}

test('Message source pages >100 persisted Queue sources with no body or manufactured receipts', async () => {
  const store = new MessageStore();
  const original = Array.from({ length: 237 }, (_, i) => append(store, i));
  const source = new MessageLiveInboxSource({ store, authorize: async () => true });
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
  assert.ok(original.every((message) => message.queueCustody?.bodyExposures === undefined));
});

test('exact target receipt facts remain independent; a legacy seen flag is not an exact read', async () => {
  const store = new MessageStore();
  const message = append(
    store,
    1,
    custody({
      notifiedByCatIds: [target],
      seenByCatIds: [target],
      seenInvocationIdByCatId: { [target]: 'legacy-child' },
      bodyExposures: [{ targetCatId: target, invocationId: 'exact-child', seenAt: 15 }],
    }),
  );
  const source = new MessageLiveInboxSource({ store, authorize: async () => true });
  const ref = await source.read(scope, message.id);
  assert.deepEqual(ref?.facts, {
    persisted: true,
    notified: true,
    readByInvocationIds: ['exact-child'],
    readInCurrentContext: false,
    handled: false,
    playback: 'unknown',
  });
});

test('permission, user/thread/target, recall, terminal and whisper boundaries are rechecked on exact reads', async () => {
  const store = new MessageStore();
  let allowed = true;
  const source = new MessageLiveInboxSource({ store, authorize: async () => allowed });
  const message = append(store);
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
  assert.ok(message.queueCustody);
  message.queueCustody.withdrawnByCatIds = [target];
  assert.equal(await source.read(scope, message.id), null);
});

test('Host append events wake during a long tool and reconnect rereads the same canonical store', async () => {
  let wakes = 0;
  const deliveries: string[] = [];
  const store = new MessageStore();
  const queue = new InvocationQueue();
  const source = new MessageLiveInboxSource({ store, queue, authorize: async () => true });
  const options = {
    scope,
    source,
    wake: () => {
      wakes++;
    },
    deliver: async (batch: { references: readonly { messageId: string }[] }) => {
      deliveries.push(...batch.references.map((item) => item.messageId));
      return 'accepted' as const;
    },
  };
  const inbox = new LiveInbox(options);
  store.onAppend = () => inbox.signal();
  const entry = queue.enqueue({
    threadId: scope.threadId,
    userId: scope.userId,
    source: 'agent',
    ownerAuthProvenance: 'strict',
    content: 'private-body-1',
    targetCats: [target],
    intent: 'coordinate',
  }).entry;
  assert.ok(entry);
  const message = append(store, 1, createInitialQueuedMessageCustody(entry));
  queue.backfillMessageId(scope.threadId, scope.userId, entry.id, message.id);
  assert.equal(wakes, 1);
  assert.equal(deliveries.length, 0);
  await inbox.atBoundary({ kind: 'tool_complete', generation: 1, userSpeaking: false });
  assert.deepEqual(deliveries, [message.id]);
  inbox.close();
  const recovered = new LiveInbox({ ...options, scope: { ...scope, invocationId: 'new-child', generation: 2 } });
  await recovered.atBoundary({ kind: 'idle', generation: 2, userSpeaking: false });
  assert.deepEqual(deliveries, [message.id, message.id]);
});

test('same-child reconnect cannot mistake a historical read for retained working context', async () => {
  const store = new MessageStore();
  const message = append(
    store,
    1,
    custody({
      bodyExposures: [{ targetCatId: target, invocationId: scope.invocationId, seenAt: 15 }],
      seenByCatIds: [target],
      seenInvocationIdByCatId: { [target]: scope.invocationId },
    }),
  );
  let retained = false;
  const source = new MessageLiveInboxSource({
    store,
    authorize: async () => true,
    retainsCurrentInvocationReads: () => retained,
  });
  assert.equal((await source.read(scope, message.id))?.facts.readInCurrentContext, false);
  const deliveries: string[] = [];
  const inbox = new LiveInbox({
    scope,
    source,
    wake() {},
    deliver: async (batch) => {
      deliveries.push(...batch.references.map((row) => row.messageId));
      return 'accepted';
    },
  });
  assert.equal(
    (await inbox.atBoundary({ kind: 'idle', generation: 1, userSpeaking: false })).kind,
    'successor_required',
  );
  assert.deepEqual(deliveries, []);
  retained = true;
  assert.equal((await inbox.atBoundary({ kind: 'idle', generation: 1, userSpeaking: false })).pending, 0);
});
