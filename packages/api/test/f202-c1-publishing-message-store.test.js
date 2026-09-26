/**
 * F202 Train C1 (G5) — every author's message enters the one stream subscribers read.
 *
 * THE GAP THIS CLOSES. Only the package messaging domain ever wrote to the messaging event log,
 * so a subscriber saw what packages said and never a cat's reply — which is the message outbound
 * delivery exists to relay. Cat replies are appended through the message store from half a dozen
 * places in the cats domain, so the fix goes at the one seam they all already pass through rather
 * than at each call site.
 *
 * TRUTH VERSUS PROJECTION. The message store is the source of truth and the event log is derived
 * from it. So a failure to publish must not destroy the message — a cat's reply that reached the
 * store has happened, and a derived-stream hiccup cannot un-happen it. But it must not be silent
 * either, which is why the failure is reported rather than logged and forgotten: a silently
 * dropped publish is a message no subscriber will ever receive.
 *
 * WHISPER IS FAIL-CLOSED. An audience-restricted message must never reach the stream, because a
 * subscriber authorised for the thread is not thereby authorised for a whisper inside it.
 *
 * STATUS when written: RED — `domains/messaging/publishing-message-store.js` does not exist.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createPublishingMessageStore;
let createMessagingStores;
let MessageStore;
let SubscriptionDrainScheduler;

let events;
let store;
let failures;

const THREAD = 'thread-1';
const USER = 'user-1';

function catReply(overrides = {}) {
  return {
    threadId: THREAD,
    userId: USER,
    catId: 'opus',
    content: 'on it',
    timestamp: Date.now(),
    ...overrides,
  };
}

async function eventsOnThread() {
  return events.readAfter(THREAD, 0, 50);
}

beforeEach(async () => {
  ({ createPublishingMessageStore } = await import('../dist/domains/messaging/publishing-message-store.js'));
  ({ createMessagingStores } = await import('../dist/domains/messaging/stores/factory.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  ({ SubscriptionDrainScheduler } = await import('../dist/domains/messaging/subscription-drain-scheduler.js'));

  events = createMessagingStores().events;
  failures = [];
  store = createPublishingMessageStore(new MessageStore(), {
    events,
    onPublishFailure: (error, stored) => failures.push({ error, stored }),
  });
});

describe('F202 C1 G5 — publishing message store', () => {
  test("case 1: a cat's reply becomes visible on the stream subscribers read", async () => {
    const stored = await store.append(catReply());

    const published = await eventsOnThread();
    assert.equal(published.length, 1, "a cat's reply must reach the stream");
    const envelope = published[0].envelope;
    assert.equal(envelope.messageId, stored.id);
    assert.deepEqual(envelope.actor, { kind: 'cat', id: 'opus' });
  });

  test('case 2: a whisper never reaches the stream', async () => {
    await store.append(catReply({ visibility: 'whisper', whisperTo: ['codex'] }));

    assert.deepEqual(await eventsOnThread(), [], 'thread authority is not whisper authority');
  });

  test('case 3: a package message is not published twice', async () => {
    // send-service already publishes these, with the watermark write that goes with it.
    await store.append(
      catReply({
        catId: null,
        extra: {
          pluginMessage: {
            instanceId: 'inst-1',
            revision: 1,
            provenance: { origin: { kind: 'plugin', instanceId: 'inst-1' }, epistemicStatus: 'user_intent' },
            elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'on it' } }],
            appendOps: [],
          },
        },
      }),
    );

    assert.deepEqual(await eventsOnThread(), [], 'the send path owns publishing its own messages');
  });

  test('case 4: a publish failure keeps the message and reports itself', async () => {
    const broken = createPublishingMessageStore(new MessageStore(), {
      events: {
        async append() {
          throw new Error('event log unavailable');
        },
      },
      onPublishFailure: (error, stored) => failures.push({ error, stored }),
    });

    const stored = await broken.append(catReply());

    assert.ok(stored?.id, 'a reply that reached the store has happened and must be returned');
    assert.equal(failures.length, 1, 'a dropped publish is a message nobody will receive — never silent');
    assert.equal(failures[0].stored.id, stored.id);
  });

  test('case 5: an idempotent replay does not publish a second time', async () => {
    const input = catReply({ idempotencyKey: 'k-1' });
    await store.appendIdempotent(input);
    await store.appendIdempotent(input);

    assert.equal((await eventsOnThread()).length, 1, 'one message is one event');
  });

  test('case 6: unrelated store methods still work through the wrapper', async () => {
    const stored = await store.append(catReply());
    const fetched = await store.getById(stored.id);
    assert.equal(fetched?.id, stored.id);
  });

  test('case 7: a successful publish schedules delivery without waiting for a slow subscriber', async () => {
    let scheduledThread;
    let releaseDrain;
    const blockedDrain = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    const draining = createPublishingMessageStore(new MessageStore(), {
      events,
      onPublishFailure: (error, stored) => failures.push({ error, stored }),
      onPublished(threadId) {
        scheduledThread = threadId;
        return blockedDrain;
      },
    });

    const stored = await draining.append(catReply());
    assert.ok(stored.id);
    assert.equal(scheduledThread, THREAD, 'the one post-publish seam must schedule this thread');
    releaseDrain();
  });

  test('case 8: a failed subscriber drain is reported without rejecting the stored message', async () => {
    const drainFailures = [];
    const scheduler = new SubscriptionDrainScheduler((error, threadId) => {
      drainFailures.push({ error, threadId });
    });
    scheduler.attach({
      async drain() {
        throw new Error('subscriber unavailable');
      },
    });
    const draining = createPublishingMessageStore(new MessageStore(), {
      events,
      onPublishFailure: (error, stored) => failures.push({ error, stored }),
      onPublished: scheduler.schedule,
    });

    const stored = await draining.append(catReply());
    assert.ok(stored.id, 'subscriber delivery is downstream of the durable message');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures.length, 0, 'a drain failure is not a publish failure');
    assert.equal(drainFailures.length, 1);
    assert.equal(drainFailures[0].threadId, THREAD);
    assert.match(drainFailures[0].error.message, /subscriber unavailable/);
  });
});
