/**
 * F202 W2-5b — the publishing seam covers the frontier appends that commit cat replies.
 *
 * THE GAP. G5 put publication at the store seam and intercepted `append` / `appendIdempotent`. In
 * production (Redis present) serial routing commits a cat's reply through the F254 freshness
 * coordinator, which writes with `appendAndObservePriorFrontier`; the proxy forwarded that method
 * untouched, so the reply reached the store and never the stream. Every package subscriber — the
 * IM connectors after cutover — would miss exactly the replies the legacy outbound hook relays.
 * The retired compare-and-append port is no longer part of the main store.
 *
 * A committed frontier write publishes like any append; a frontier that moved writes nothing and
 * therefore publishes nothing; an idempotent re-resolution does not publish twice.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createPublishingMessageStore;
let createMessagingStores;
let MessageStore;

const THREAD = 'thread-1';
let stores;
let store;

function catReply(overrides = {}) {
  return {
    from: { kind: 'agent', catId: 'opus' },
    threadId: THREAD,
    userId: 'user-1',
    content: 'on it',
    timestamp: Date.now(),
    ...overrides,
  };
}

async function publishedIds() {
  return (await stores.events.readAfter(THREAD, 0, 50)).map((e) => e.envelope.messageId);
}

beforeEach(async () => {
  ({ createPublishingMessageStore } = await import('../dist/domains/messaging/publishing-message-store.js'));
  ({ createMessagingStores } = await import('../dist/domains/messaging/stores/factory.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  stores = createMessagingStores();
  store = createPublishingMessageStore(new MessageStore(), {
    events: stores.events,
    publications: stores.publications,
    onPublishFailure: (error) => {
      throw error;
    },
  });
});

describe('F202 W2-5b — frontier appends reach the stream', () => {
  test('a cat reply committed by the freshness coordinator is published once', async () => {
    const input = catReply({ idempotencyKey: 'reply-1' });
    const first = await store.appendAndObservePriorFrontier(input);
    const again = await store.appendAndObservePriorFrontier(input);

    assert.equal(again.idempotent, true);
    assert.deepEqual(await publishedIds(), [first.message.id]);
  });

  test('frontier observation holds the publication span until the event is appended', async () => {
    const seen = [];
    const seam = createPublishingMessageStore(new MessageStore(), {
      events: {
        async append(...args) {
          seen.push(stores.publications.isBusy(THREAD));
          return stores.events.append(...args);
        },
      },
      publications: stores.publications,
      onPublishFailure: (error) => {
        throw error;
      },
    });

    await seam.appendAndObservePriorFrontier(catReply());

    assert.deepEqual(seen, [true]);
    assert.equal(stores.publications.isBusy(THREAD), false);
  });
});
