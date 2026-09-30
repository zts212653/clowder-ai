/**
 * F202 W2-5b-0 — the catch-up snapshot carries every author's message, not only package messages.
 *
 * THE GAP. `isSnapshotCandidate` admitted only rows with `extra.pluginMessage`, so a subscriber that
 * fell behind the event log's retention window and caught up by snapshot never saw a cat's reply or
 * a user's message. Once W2-5b delays the publication of Host messages that carry media, the final
 * media message would be unrecoverable after the event is trimmed.
 *
 * THE RACE THIS MUST NOT OPEN. A Host message is written to the message store first and its publish
 * event is appended right after. A snapshot taken inside that gap would carry the message and then
 * the event would deliver it a second time. Package messages avoid this with their persisted output
 * watermark; Host messages have none, so the publishing seam marks the thread busy for the whole
 * append → publish span and a snapshot that ends while the thread is busy retries.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createPublishingMessageStore;
let createMessagingStores;
let createMessagingDomain;
let MessageStore;

const THREAD = 'thread-1';
const USER = 'user-1';

let stores;
let inner;
let store;
let messaging;
let subscriber;
let subscriptionId;

function catReply(overrides = {}) {
  return { threadId: THREAD, userId: USER, catId: 'opus', content: 'on it', timestamp: Date.now(), ...overrides };
}

beforeEach(async () => {
  ({ createPublishingMessageStore } = await import('../dist/domains/messaging/publishing-message-store.js'));
  ({ createMessagingStores } = await import('../dist/domains/messaging/stores/factory.js'));
  ({ createMessagingDomain } = await import('../dist/domains/messaging/messaging-service.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  stores = createMessagingStores();
  inner = new MessageStore();
  store = createPublishingMessageStore(inner, {
    events: stores.events,
    publications: stores.publications,
    onPublishFailure: (error) => {
      throw error;
    },
  });
  messaging = createMessagingDomain({ messageStore: store, stores });
  subscriber = { pluginInstanceId: 'subscriber' };
  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId: 'subscriber',
    threadId: THREAD,
    userId: USER,
    scope: { canSend: false, canSubscribe: true },
  });
  ({ subscriptionId } = await messaging.subscribe(subscriber, handleId));
});

describe('F202 W2-5b-0 — Host messages in the catch-up snapshot', () => {
  test("a cat's reply and a user's message are in the snapshot", async () => {
    const user = await store.append(catReply({ catId: null, content: 'please look' }));
    const cat = await store.append(catReply());

    const { envelopes } = await messaging.snapshot(subscriber, subscriptionId);

    assert.deepEqual(
      envelopes.map((e) => [e.messageId, e.actor.kind]),
      [
        [user.id, 'user'],
        [cat.id, 'cat'],
      ],
    );
  });

  test('the paged snapshot carries the same Host messages', async () => {
    const cat = await store.append(catReply());

    const page = await messaging.snapshotPage(subscriber, { subscriptionId, maxItems: 10 });

    assert.deepEqual(
      page.items.map((e) => e.messageId),
      [cat.id],
    );
  });

  test('a whisper never enters the snapshot', async () => {
    await store.append(catReply({ visibility: 'whisper', whisperTo: ['codex'] }));
    const visible = await store.append(catReply({ content: 'public' }));

    const { envelopes } = await messaging.snapshot(subscriber, subscriptionId);

    assert.deepEqual(
      envelopes.map((e) => e.messageId),
      [visible.id],
    );
  });

  test('a snapshot inside the append → publish gap retries instead of delivering the message twice', async () => {
    const end = stores.publications.begin(THREAD);
    await inner.append(catReply({ content: 'stored, not yet published' }));

    await assert.rejects(messaging.snapshot(subscriber, subscriptionId), (e) => e?.code === 'RETRYABLE_INFLIGHT');

    end();
    const { envelopes } = await messaging.snapshot(subscriber, subscriptionId);
    assert.equal(envelopes.length, 1);
  });

  test('the publishing seam holds the thread busy until its publish event is appended', async () => {
    let busyDuringAppend;
    const events = {
      async append(...args) {
        busyDuringAppend = stores.publications.isBusy(THREAD);
        return stores.events.append(...args);
      },
    };
    const seam = createPublishingMessageStore(new MessageStore(), {
      events,
      publications: stores.publications,
      onPublishFailure: (error) => {
        throw error;
      },
    });

    await seam.append(catReply());

    assert.equal(busyDuringAppend, true, 'the gap between store and stream must be visible to snapshots');
    assert.equal(stores.publications.isBusy(THREAD), false, 'the thread is released after publication');
  });

  test('a failed publish still releases the thread', async () => {
    const seam = createPublishingMessageStore(new MessageStore(), {
      events: {
        async append() {
          throw new Error('event log down');
        },
      },
      publications: stores.publications,
      onPublishFailure: () => {},
    });

    await seam.append(catReply());

    assert.equal(stores.publications.isBusy(THREAD), false);
  });
});
