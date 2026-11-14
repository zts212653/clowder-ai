import assert from 'node:assert/strict';
import test from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { createPublishingMessageStore } from '../src/domains/messaging/publishing-message-store.js';
import { createMessagingStores } from '../src/domains/messaging/stores/factory.js';
import './helpers/setup-cat-registry.js';

test('an atomic visible notice publishes without exposing its private Queue payload', async () => {
  const events = createMessagingStores().events;
  const store = createPublishingMessageStore(new MessageStore(), {
    events,
    onPublishFailure: (error) => {
      throw error;
    },
  });
  const queue = new InvocationQueue(new InMemoryQueueLedgerStore());
  const from = { kind: 'user' as const, userId: 'owner' };
  const admitted = await queue.enqueueDurableWithVisibleNotice(
    {
      threadId: 'selected',
      userId: 'owner',
      from,
      sourceId: 'private-follow-up',
      targetCats: ['codex'],
      kind: 'private_input',
      content: 'private execution instructions',
      intent: 'follow-up',
      ownerAuthProvenance: 'strict',
    },
    { threadId: 'selected', userId: 'owner', from, content: 'Follow-up started', mentions: [], timestamp: Date.now() },
    store,
  );
  assert.ok(admitted.notice);
  const published = await events.readAfter('selected', 0, 20);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'message.publish');
  if (published[0].type === 'message.publish') assert.equal(published[0].envelope.messageId, admitted.notice.id);
  assert.ok(!JSON.stringify(published).includes('private execution instructions'));
});

test('ordinary atomic Queue input reaches subscribers when it becomes visible; replay keeps one event', async () => {
  const events = createMessagingStores().events;
  const store = createPublishingMessageStore(new MessageStore(), {
    events,
    onPublishFailure: (error) => {
      throw error;
    },
  });
  const queue = new InvocationQueue(new InMemoryQueueLedgerStore());
  const input = {
    threadId: 'selected',
    userId: 'owner',
    from: { kind: 'user' as const, userId: 'owner' },
    content: '请分别完成两件事。',
    mentions: [],
    timestamp: Date.now(),
    deliveryStatus: 'queued' as const,
  };
  const sent = await queue.send(store, input, {
    ...input,
    sourceId: 'user-input',
    targetCats: ['codex'],
    kind: 'conversation_input',
    intent: 'execute',
    exactTargets: true,
    ownerAuthProvenance: 'strict',
  });
  assert.ok(sent.message);
  assert.deepEqual(await events.readAfter('selected', 0, 20), [], 'private queued work is not a published request');
  await store.markDelivered(sent.message.id, Date.now());
  const published = await events.readAfter('selected', 0, 20);
  assert.equal(published.length, 1, 'the real Queue path must not bypass subscriber publication');
  assert.equal(published[0].type, 'message.publish');
  if (published[0].type === 'message.publish') assert.equal(published[0].envelope.messageId, sent.message.id);
  await store.markDelivered(sent.message.id, Date.now());
  assert.equal((await events.readAfter('selected', 0, 20)).length, 1);
});

test('legacy queued append stays private, and whisper delivery remains excluded', async () => {
  const events = createMessagingStores().events;
  const store = createPublishingMessageStore(new MessageStore(), {
    events,
    onPublishFailure: (error) => {
      throw error;
    },
  });
  const queued = await store.append({
    threadId: 'selected',
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    content: 'private pending input',
    mentions: [],
    timestamp: Date.now(),
    deliveryStatus: 'queued',
    visibility: 'whisper',
    whisperTo: ['codex'],
  });
  await store.markDelivered(queued.id, Date.now());
  assert.deepEqual(await events.readAfter('selected', 0, 20), []);
  await store.append({
    threadId: 'selected',
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    content: 'not delivered yet',
    mentions: [],
    timestamp: Date.now(),
    deliveryStatus: 'queued',
  });
  assert.deepEqual(
    await events.readAfter('selected', 0, 20),
    [],
    'pending user input remains private before promotion',
  );
});

test('atomic admission publishes already-visible cat speech without waiting for execution delivery', async () => {
  const events = createMessagingStores().events;
  const store = createPublishingMessageStore(new MessageStore(), {
    events,
    onPublishFailure: (error) => {
      throw error;
    },
  });
  const queue = new InvocationQueue(new InMemoryQueueLedgerStore());
  const input = {
    threadId: 'selected',
    userId: 'owner',
    from: { kind: 'agent' as const, catId: 'codex' },
    content: 'I can follow this up.',
    mentions: [],
    timestamp: Date.now(),
    deliveryStatus: 'queued' as const,
  };
  const sent = await queue.send(store, input, {
    ...input,
    sourceId: 'cat-speech',
    targetCats: [],
    kind: 'conversation_input',
    intent: 'conversation',
    ownerAuthProvenance: 'strict',
  });
  assert.ok(sent.message);
  assert.equal((await events.readAfter('selected', 0, 20)).length, 1);
  await store.markDelivered(sent.message.id, Date.now());
  assert.equal((await events.readAfter('selected', 0, 20)).length, 1);
});
