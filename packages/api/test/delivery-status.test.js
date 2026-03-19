/**
 * F117: Message Delivery Lifecycle Tests
 * deliveryStatus field + isDelivered + markCanceled + markDelivered + filters
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F117: deliveryStatus + isDelivered', () => {
  test('isDelivered returns true for legacy messages (no deliveryStatus)', async () => {
    const { isDelivered } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const msg = { deliveryStatus: undefined };
    assert.equal(isDelivered(msg), true);
  });

  test('isDelivered returns true for deliveryStatus="delivered"', async () => {
    const { isDelivered } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    assert.equal(isDelivered({ deliveryStatus: 'delivered' }), true);
  });

  test('isDelivered returns false for deliveryStatus="queued"', async () => {
    const { isDelivered } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    assert.equal(isDelivered({ deliveryStatus: 'queued' }), false);
  });

  test('isDelivered returns false for deliveryStatus="canceled"', async () => {
    const { isDelivered } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    assert.equal(isDelivered({ deliveryStatus: 'canceled' }), false);
  });

  test('markCanceled sets deliveryStatus to canceled', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const msg = store.append({
      userId: 'user-1',
      catId: null,
      content: 'queued msg',
      mentions: [],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });
    const result = store.markCanceled(msg.id);
    assert.equal(result?.deliveryStatus, 'canceled');
  });

  test('markCanceled returns null for nonexistent message', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    assert.equal(store.markCanceled('nonexistent'), null);
  });

  test('markDelivered sets both deliveredAt and deliveryStatus', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const msg = store.append({
      userId: 'user-1',
      catId: null,
      content: 'queued msg',
      mentions: [],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });
    const now = Date.now();
    const result = store.markDelivered(msg.id, now);
    assert.equal(result?.deliveredAt, now);
    assert.equal(result?.deliveryStatus, 'delivered');
  });

  test('markDelivered is no-op for legacy messages (deliveryStatus=undefined)', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const msg = store.append({
      userId: 'user-1',
      catId: null,
      content: 'immediate msg',
      mentions: [],
      timestamp: Date.now() - 60_000,
      // no deliveryStatus → undefined (legacy/immediate path)
    });
    assert.equal(msg.deliveryStatus, undefined, 'precondition: no deliveryStatus');

    const result = store.markDelivered(msg.id, Date.now());
    // undefined is not queued — no-op, prevents timeline re-scoring
    assert.equal(result?.deliveryStatus, undefined, 'must not overwrite undefined to delivered');
    assert.equal(result?.deliveredAt, undefined, 'must not set deliveredAt');
  });

  test('markDelivered is no-op for already-delivered messages', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const msg = store.append({
      userId: 'user-1',
      catId: null,
      content: 'already delivered',
      mentions: [],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    });
    const firstDeliveredAt = Date.now() - 1000;
    store.markDelivered(msg.id, firstDeliveredAt);
    assert.equal(msg.deliveryStatus, 'delivered');

    // Second call should be no-op
    const result = store.markDelivered(msg.id, Date.now());
    assert.equal(result?.deliveredAt, firstDeliveredAt, 'must not overwrite deliveredAt');
  });
});

// AC-A3: History API filters by deliveryStatus
describe('F117: getByThread filters undelivered messages', () => {
  test('getByThread excludes queued and canceled messages', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const now = Date.now();

    // legacy message (no deliveryStatus) — should appear
    store.append({ userId: 'u1', catId: null, content: 'legacy', mentions: [], timestamp: now });
    // delivered message — should appear
    store.append({
      userId: 'u1',
      catId: null,
      content: 'delivered',
      mentions: [],
      timestamp: now + 1,
      deliveryStatus: 'delivered',
    });
    // queued message — should NOT appear
    store.append({
      userId: 'u1',
      catId: null,
      content: 'queued',
      mentions: [],
      timestamp: now + 2,
      deliveryStatus: 'queued',
    });
    // canceled message — should NOT appear
    store.append({
      userId: 'u1',
      catId: null,
      content: 'canceled',
      mentions: [],
      timestamp: now + 3,
      deliveryStatus: 'canceled',
    });

    const results = store.getByThread('default', 50, 'u1');
    const contents = results.map((m) => m.content);
    assert.ok(contents.includes('legacy'), 'legacy message should appear');
    assert.ok(contents.includes('delivered'), 'delivered message should appear');
    assert.ok(!contents.includes('queued'), 'queued message should NOT appear');
    assert.ok(!contents.includes('canceled'), 'canceled message should NOT appear');
  });
});

// P1-1: getByThreadAfter must also filter undelivered (review R1)
describe('F117: getByThreadAfter filters undelivered messages', () => {
  test('getByThreadAfter excludes queued and canceled messages', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const now = Date.now();

    const m1 = store.append({
      userId: 'u1',
      catId: null,
      content: 'delivered',
      mentions: [],
      timestamp: now,
      deliveryStatus: 'delivered',
    });
    store.append({
      userId: 'u1',
      catId: null,
      content: 'queued',
      mentions: [],
      timestamp: now + 1,
      deliveryStatus: 'queued',
    });
    store.append({
      userId: 'u1',
      catId: null,
      content: 'canceled',
      mentions: [],
      timestamp: now + 2,
      deliveryStatus: 'canceled',
    });
    store.append({
      userId: 'u1',
      catId: null,
      content: 'legacy',
      mentions: [],
      timestamp: now + 3,
    });

    // Fetch after first message — should only see legacy (delivered compat), not queued/canceled
    const results = store.getByThreadAfter('default', m1.id, undefined, 'u1');
    const contents = results.map((m) => m.content);
    assert.ok(!contents.includes('queued'), 'queued should NOT appear in getByThreadAfter');
    assert.ok(!contents.includes('canceled'), 'canceled should NOT appear in getByThreadAfter');
    assert.ok(contents.includes('legacy'), 'legacy should appear');
  });
});

// AC-A4: ContextAssembler filters undelivered messages
describe('F117: assembleContext filters undelivered messages', () => {
  test('assembleContext excludes queued and canceled messages', async () => {
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const now = Date.now();

    const messages = [
      {
        id: 'm1',
        threadId: 'default',
        userId: 'u1',
        catId: null,
        content: 'visible msg',
        mentions: [],
        timestamp: now,
      },
      {
        id: 'm2',
        threadId: 'default',
        userId: 'u1',
        catId: null,
        content: 'queued msg',
        mentions: [],
        timestamp: now + 1,
        deliveryStatus: 'queued',
      },
      {
        id: 'm3',
        threadId: 'default',
        userId: 'u1',
        catId: null,
        content: 'canceled msg',
        mentions: [],
        timestamp: now + 2,
        deliveryStatus: 'canceled',
      },
      {
        id: 'm4',
        threadId: 'default',
        userId: 'u1',
        catId: null,
        content: 'delivered msg',
        mentions: [],
        timestamp: now + 3,
        deliveryStatus: 'delivered',
      },
    ];

    const result = assembleContext(messages);
    assert.ok(result.contextText.includes('visible msg'), 'legacy message should appear');
    assert.ok(result.contextText.includes('delivered msg'), 'delivered message should appear');
    assert.ok(!result.contextText.includes('queued msg'), 'queued message should NOT appear in context');
    assert.ok(!result.contextText.includes('canceled msg'), 'canceled message should NOT appear in context');
    assert.equal(result.messageCount, 2);
  });
});

// AC-A9: getMentionsFor filters undelivered messages
describe('F117: getMentionsFor filters undelivered messages', () => {
  test('getMentionsFor excludes queued and canceled mentions', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const now = Date.now();

    // delivered mention — should appear
    store.append({
      userId: 'u1',
      catId: null,
      content: '@gpt52 delivered',
      mentions: ['gpt52'],
      timestamp: now,
      deliveryStatus: 'delivered',
    });
    // queued mention — should NOT appear
    store.append({
      userId: 'u1',
      catId: null,
      content: '@gpt52 queued',
      mentions: ['gpt52'],
      timestamp: now + 1,
      deliveryStatus: 'queued',
    });
    // canceled mention — should NOT appear
    store.append({
      userId: 'u1',
      catId: null,
      content: '@gpt52 canceled',
      mentions: ['gpt52'],
      timestamp: now + 2,
      deliveryStatus: 'canceled',
    });
    // legacy mention (no deliveryStatus) — should appear
    store.append({ userId: 'u1', catId: null, content: '@gpt52 legacy', mentions: ['gpt52'], timestamp: now + 3 });

    const mentions = store.getMentionsFor('gpt52', 50, 'u1');
    const contents = mentions.map((m) => m.content);
    assert.ok(contents.includes('@gpt52 delivered'), 'delivered mention should appear');
    assert.ok(contents.includes('@gpt52 legacy'), 'legacy mention should appear');
    assert.ok(!contents.includes('@gpt52 queued'), 'queued mention should NOT appear');
    assert.ok(!contents.includes('@gpt52 canceled'), 'canceled mention should NOT appear');
  });

  test('getRecentMentionsFor excludes queued and canceled mentions', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const now = Date.now();

    store.append({
      userId: 'u1',
      catId: null,
      content: '@gpt52 delivered',
      mentions: ['gpt52'],
      timestamp: now,
      deliveryStatus: 'delivered',
    });
    store.append({
      userId: 'u1',
      catId: null,
      content: '@gpt52 queued',
      mentions: ['gpt52'],
      timestamp: now + 1,
      deliveryStatus: 'queued',
    });

    const mentions = store.getRecentMentionsFor('gpt52', 50, 'u1');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].content, '@gpt52 delivered');
  });
});

// AC-A5: messages_delivered event payload includes full message data
describe('F117: messages_delivered payload includes message data', () => {
  test('markDelivered returns full StoredMessage with deliveryStatus=delivered', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const now = Date.now();

    const msg = store.append({
      userId: 'u1',
      catId: null,
      content: 'hello cat',
      mentions: ['gpt52'],
      timestamp: now,
      deliveryStatus: 'queued',
    });

    const delivered = store.markDelivered(msg.id, now + 100);

    // Must return full message data needed for frontend bubble rendering
    assert.ok(delivered, 'markDelivered should return the message');
    assert.equal(delivered.id, msg.id);
    assert.equal(delivered.content, 'hello cat');
    assert.equal(delivered.catId, null);
    assert.equal(delivered.timestamp, now);
    assert.equal(delivered.deliveryStatus, 'delivered');
    assert.equal(delivered.deliveredAt, now + 100);
    assert.deepEqual(delivered.mentions, ['gpt52']);
    assert.equal(delivered.userId, 'u1');
  });
});

// AC-A8: Integration regression — queue send → cancel → invisible everywhere
describe('F117: integration regression', () => {
  test('queue send → cancel → history/context/mentions all clean', async () => {
    const { MessageStore, isDelivered } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { assembleContext } = await import('../dist/domains/cats/services/context/ContextAssembler.js');
    const store = new MessageStore();
    const now = Date.now();

    // Simulate queue send
    const queuedMsg = store.append({
      userId: 'u1',
      catId: null,
      content: '@gpt52 嘿嘿大猫猫喵',
      mentions: ['gpt52'],
      timestamp: now,
      deliveryStatus: 'queued',
    });

    // Before cancel: message exists but should be invisible
    assert.equal(isDelivered(queuedMsg), false);

    // History should not include it
    const history = store.getByThread('default', 50, 'u1');
    assert.ok(!history.some((m) => m.content.includes('嘿嘿大猫猫喵')), 'queued msg not in history');

    // Context should not include it
    const allMsgs = store.getByThread('default', 50, 'u1');
    const ctx = assembleContext(allMsgs);
    assert.ok(!ctx.contextText.includes('嘿嘿大猫猫喵'), 'queued msg not in context');

    // Mentions should not include it
    const mentions = store.getMentionsFor('gpt52', 50, 'u1');
    assert.ok(!mentions.some((m) => m.content.includes('嘿嘿大猫猫喵')), 'queued msg not in mentions');

    // Simulate cancel
    store.markCanceled(queuedMsg.id);
    assert.equal(queuedMsg.deliveryStatus, 'canceled');

    // After cancel: still invisible
    const historyAfter = store.getByThread('default', 50, 'u1');
    assert.ok(!historyAfter.some((m) => m.content.includes('嘿嘿大猫猫喵')), 'canceled msg not in history');

    const mentionsAfter = store.getMentionsFor('gpt52', 50, 'u1');
    assert.ok(!mentionsAfter.some((m) => m.content.includes('嘿嘿大猫猫喵')), 'canceled msg not in mentions');
  });
});
