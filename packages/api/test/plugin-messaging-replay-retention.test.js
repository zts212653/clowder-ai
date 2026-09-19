import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';
import { createMessagingOwner } from './plugin-m0d-messaging-owner.js';

const THREAD_ID = 'thread-replay-retention';
const OWNER_CTX = { pluginInstanceId: 'plugin-a' };
const FOREIGN_CTX = { pluginInstanceId: 'plugin-b' };

function eventInput() {
  return {
    eventId: 'event-1',
    type: 'message.publish',
    envelope: {
      messageId: 'message-1',
      revision: 1,
      threadId: THREAD_ID,
      actor: { kind: 'plugin', id: 'plugin-a' },
      audience: { kind: 'public' },
      occurredAt: '2026-08-27T00:00:00.000Z',
      payload: {
        provenance: {
          origin: { kind: 'plugin', instanceId: 'plugin-a' },
          epistemicStatus: 'inference',
        },
        elements: [{ elementId: 'element-1', kind: 'text', payload: { text: 'retained' } }],
      },
    },
  };
}

async function seedSubscription(owner, pluginInstanceId, subscriptionId, handleId) {
  await owner.handleStore.put({
    handleId,
    kind: 'thread_handle',
    pluginInstanceId,
    threadId: THREAD_ID,
    userId: 'fixture-user',
    scope: { canSend: true, canSubscribe: true },
    issuedAt: 1,
  });
  await owner.cursorStore.put({
    subscriptionId,
    pluginInstanceId,
    handleId,
    threadId: THREAD_ID,
    ackedSequence: 0,
    lastDeliveredSequence: 0,
    replayFloorSequence: 0,
  });
}

async function seededOwner() {
  const owner = await createMessagingOwner(500);
  await seedSubscription(owner, 'plugin-a', 'subscription-a', 'handle-a');
  await seedSubscription(owner, 'plugin-b', 'subscription-b', 'handle-b');
  // F117: append requires MessageFrom sender identity
  owner.messageStore.append(
    canonicalTestMessageInput({
      userId: 'fixture-user',
      catId: null,
      content: 'canonical message must survive replay cleanup',
      mentions: [],
      timestamp: Date.now(),
      threadId: THREAD_ID,
    }),
  );
  await owner.events.append(THREAD_ID, 'event-key-1', eventInput(), 500);
  return owner;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.name === 'MessagingError' && error.code === code);
}

test('Host replay cleanup is subscription-local and preserves shared events plus canonical messages', async () => {
  const owner = await seededOwner();

  await owner.stream.deleteReplayEvents(OWNER_CTX, 'subscription-a', 1);

  assert.deepEqual(
    {
      ackedSequence: (await owner.cursorStore.get('plugin-a', 'subscription-a')).ackedSequence,
      lastDeliveredSequence: (await owner.cursorStore.get('plugin-a', 'subscription-a')).lastDeliveredSequence,
      replayFloorSequence: (await owner.cursorStore.get('plugin-a', 'subscription-a')).replayFloorSequence,
    },
    { ackedSequence: 0, lastDeliveredSequence: 0, replayFloorSequence: 1 },
  );
  assert.equal((await owner.messageStore.getRecent(10)).length, 1);
  assert.equal((await owner.events.readAfter(THREAD_ID, 0, 10)).length, 1);

  assert.deepEqual(await owner.stream.read(OWNER_CTX, 'subscription-a', {}), {
    events: [],
    ackToken: null,
    stale: true,
  });
  assert.equal((await owner.stream.read(FOREIGN_CTX, 'subscription-b', {})).events.length, 1);

  await owner.stream.deleteReplayEvents(OWNER_CTX, 'subscription-a', 1);
  await owner.stream.deleteReplayEvents(OWNER_CTX, 'subscription-a', 0);
  assert.equal((await owner.cursorStore.get('plugin-a', 'subscription-a')).replayFloorSequence, 1);

  await assert.rejects(
    owner.stream.deleteReplayEvents(FOREIGN_CTX, 'subscription-a', 1),
    (error) => error?.code === 'PERMISSION',
  );
  assert.equal((await owner.cursorStore.get('plugin-a', 'subscription-a')).replayFloorSequence, 1);
});

test('replay cleanup validates its boundary and cannot mutate a revoked subscription', async () => {
  const owner = await seededOwner();
  for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    // eslint-disable-next-line no-await-in-loop
    await expectCode(owner.stream.deleteReplayEvents(OWNER_CTX, 'subscription-a', sequence), 'VALIDATION');
  }
  assert.equal((await owner.cursorStore.get('plugin-a', 'subscription-a')).replayFloorSequence, 0);

  await owner.handleStore.revoke('handle-a', 77);
  await expectCode(owner.stream.deleteReplayEvents(OWNER_CTX, 'subscription-a', 1), 'PERMISSION');
  assert.equal((await owner.cursorStore.get('plugin-a', 'subscription-a')).replayFloorSequence, 0);
});

test('replay cleanup rejects a floor beyond the recoverable event head', async () => {
  const owner = await seededOwner();

  await expectCode(owner.stream.deleteReplayEvents(OWNER_CTX, 'subscription-a', 2), 'VALIDATION');
  assert.equal((await owner.cursorStore.get('plugin-a', 'subscription-a')).replayFloorSequence, 0);
});

test('replay cleanup racing handle revocation cannot advance after the authoritative revoke', async () => {
  const owner = await seededOwner();
  const [{ EventStreamService }, { HandleService }] = await Promise.all([
    import('../dist/domains/messaging/event-stream.js'),
    import('../dist/domains/messaging/handles.js'),
  ]);
  let resumeHead;
  let reportHeadBlocked;
  const headBlocked = new Promise((resolve) => {
    reportHeadBlocked = resolve;
  });
  const headGate = new Promise((resolve) => {
    resumeHead = resolve;
  });
  const racingEvents = new Proxy(owner.events, {
    get(target, property, receiver) {
      if (property === 'headSequence') {
        return async (...args) => {
          const head = await target.headSequence(...args);
          reportHeadBlocked();
          await headGate;
          return head;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  let releaseCascade;
  let reportAuthoritativeRevoke;
  const authoritativeRevokeObserved = new Promise((resolve) => {
    reportAuthoritativeRevoke = resolve;
  });
  const cascadeGate = new Promise((resolve) => {
    releaseCascade = resolve;
  });
  const racingCursors = new Proxy(owner.cursorStore, {
    get(target, property, receiver) {
      if (property === 'revokeByHandle') {
        return async (...args) => {
          const handle = await owner.handleStore.get(args[0]);
          if (handle?.revokedAt !== undefined) {
            reportAuthoritativeRevoke();
            await cascadeGate;
          }
          return target.revokeByHandle(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const racingHandles = new HandleService(owner.handleStore, racingCursors);
  const racingStream = new EventStreamService({
    events: racingEvents,
    cursors: racingCursors,
    handles: racingHandles,
    messageStore: owner.messageStore,
  });

  const deletePromise = racingStream.deleteReplayEvents(OWNER_CTX, 'subscription-a', 1);
  await headBlocked;
  const revokePromise = racingHandles.revoke('handle-a');
  await authoritativeRevokeObserved;
  resumeHead();

  let deleteError;
  try {
    await deletePromise;
  } catch (error) {
    deleteError = error;
  }
  const floorBeforeCascadeCompletes = (await owner.cursorStore.get('plugin-a', 'subscription-a')).replayFloorSequence;
  releaseCascade();
  await revokePromise;

  assert.equal(deleteError?.code, 'PERMISSION');
  assert.equal(floorBeforeCascadeCompletes, 0);
  assert.equal((await owner.cursorStore.get('plugin-a', 'subscription-a')).replayFloorSequence, 0);
});

test('memory replay-floor advances converge on the monotonic maximum without moving delivery truth', async () => {
  const owner = await seededOwner();
  assert.deepEqual(
    await Promise.all([
      owner.cursorStore.advanceReplayFloor('plugin-a', 'subscription-a', 3),
      owner.cursorStore.advanceReplayFloor('plugin-a', 'subscription-a', 9),
      owner.cursorStore.advanceReplayFloor('plugin-a', 'subscription-a', 7),
    ]),
    [true, true, true],
  );
  const record = await owner.cursorStore.get('plugin-a', 'subscription-a');
  assert.deepEqual(
    {
      ackedSequence: record.ackedSequence,
      lastDeliveredSequence: record.lastDeliveredSequence,
      replayFloorSequence: record.replayFloorSequence,
    },
    { ackedSequence: 0, lastDeliveredSequence: 0, replayFloorSequence: 9 },
  );
});

test('a replay-floor advance racing read returns stale instead of silently skipping the deleted prefix', async () => {
  const owner = await seededOwner();
  const { EventStreamService } = await import('../dist/domains/messaging/event-stream.js');
  let pageObserved = false;
  const racingEvents = {
    async readAfter(...args) {
      const result = await owner.events.readAfter(...args);
      pageObserved = true;
      return result;
    },
    minSequence: (...args) => owner.events.minSequence(...args),
    headSequence: (...args) => owner.events.headSequence(...args),
    append: (...args) => owner.events.append(...args),
  };
  const racingCursors = new Proxy(owner.cursorStore, {
    get(target, property, receiver) {
      if (property === 'get') {
        return async (...args) => {
          const record = await target.get(...args);
          return pageObserved && record ? { ...record, replayFloorSequence: 1 } : record;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const racingStream = new EventStreamService({
    events: racingEvents,
    cursors: racingCursors,
    handles: {
      resolveForSubscribe: (...args) => owner.handleStore.get(args[1]),
    },
    messageStore: owner.messageStore,
  });

  assert.deepEqual(await racingStream.read(OWNER_CTX, 'subscription-a', {}), {
    events: [],
    ackToken: null,
    stale: true,
  });
});
