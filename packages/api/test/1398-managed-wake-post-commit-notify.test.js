import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { createManagedWakeAdmittedNotifier } = await import(
  '../dist/domains/ball-custody/managed-wake-admitted-notifier.js'
);

/**
 * #1398 — what happens AFTER a managed wake is already durable.
 *
 * The previous attempt at this case threw inside its own test double and caught it there, so it
 * never reached the production notifier at all: reverting the fix left it green. It proved nothing.
 * These cases drive the real `createManagedWakeAdmittedNotifier` that composition wires, so the
 * failure modes are the ones production actually has.
 *
 * Two properties, and the second is the one that was broken:
 *   1. Nothing here may reject. Queue commit is the durable boundary; a caller handed an error
 *      would release its claim and record "nothing was written" about committed work.
 *   2. The drain is not downstream of the UI broadcast. A wake nobody drains is a wake nobody
 *      receives, and a failed Queue-panel refresh has no bearing on whether a committed row runs.
 */
function collectLog() {
  const warnings = [];
  return { warnings, log: { warn: (context, message) => warnings.push({ context, message }) } };
}

describe('#1398 managed wake post-commit notification', () => {
  test('signals the drain even when the Queue panel broadcast fails', async () => {
    const drains = [];
    const { warnings, log } = collectLog();
    const notify = createManagedWakeAdmittedNotifier({
      broadcastQueueUpdate: async () => {
        throw new Error('socket fan-out unavailable');
      },
      requestDrain: async (threadId) => drains.push(threadId),
      log,
    });

    await assert.doesNotReject(() => notify('thread-1', 'user-1'));

    // The regression: sequencing the drain behind the broadcast in one try block meant a broken
    // socket left a durable wake that nothing asked anyone to look at.
    assert.deepEqual(drains, ['thread-1'], 'the drain runs exactly once regardless of the broadcast');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /broadcast failed/);
  });

  test('a drain rejection is contained, not surfaced to the producer', async () => {
    const { warnings, log } = collectLog();
    const notify = createManagedWakeAdmittedNotifier({
      broadcastQueueUpdate: async () => {},
      // Async rejection specifically: the old code called requestDrain without awaiting it, so a
      // rejected promise escaped the surrounding catch entirely as an unhandled rejection.
      requestDrain: async () => {
        throw new Error('drain scheduler unavailable');
      },
      log,
    });

    await assert.doesNotReject(() => notify('thread-1', 'user-1'));

    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /drain signal failed/);
  });

  test('both failing still cannot reject, and each is reported once', async () => {
    const { warnings, log } = collectLog();
    const notify = createManagedWakeAdmittedNotifier({
      broadcastQueueUpdate: async () => {
        throw new Error('socket fan-out unavailable');
      },
      requestDrain: async () => {
        throw new Error('drain scheduler unavailable');
      },
      log,
    });

    await assert.doesNotReject(() => notify('thread-1', 'user-1'));
    assert.equal(warnings.length, 2, 'each side effect is reported on its own');
  });

  test('the happy path broadcasts once and drains once', async () => {
    const calls = [];
    const notify = createManagedWakeAdmittedNotifier({
      broadcastQueueUpdate: async (threadId, userId) => calls.push(`broadcast:${threadId}:${userId}`),
      requestDrain: async (threadId) => calls.push(`drain:${threadId}`),
      log: collectLog().log,
    });

    await notify('thread-1', 'user-1');

    assert.deepEqual(calls, ['broadcast:thread-1:user-1', 'drain:thread-1']);
  });
});
