/**
 * F254/F167 — fan-out queue custody CAS contention.
 *
 * Regression for thread_mrqb0yfauece1tmm (2026-08-19): fan-out entries share
 * one messageId's custody revision, so N concurrent invocations CAS the same
 * counter. The old tight 3-round retry loop lost deterministically under
 * fan-out contention ("queue custody CAS retries exhausted"), flipping healthy
 * invocations to failed and rolling their queue entries back into a wedged
 * queue head. The exponential backoff (8 rounds) lets siblings linearize.
 *
 * Contention is manufactured realistically: in production the custody read is
 * a Redis round-trip, so concurrent settlers all read the SAME stale revision
 * before any CAS lands. An in-memory MessageStore resolves synchronously and
 * FIFO scheduling would let every retry see the freshest revision — no
 * contention at all. The wrapped store below serves a cached snapshot for a
 * short window (concurrent reads overlap), which is the exact production
 * shape: N settlers hold identical stale revisions, every CAS but one fails.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  casBackoffDelayMs,
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const READ_CACHE_WINDOW_MS = 12;

/** Serve concurrent getById calls the same cached snapshot, like Redis RTTs. */
function staleWindowStore(store) {
  let cache;
  return {
    getById: async (messageId) => {
      const at = Date.now();
      if (!cache || at - cache.fetchedAt >= READ_CACHE_WINDOW_MS || cache.messageId !== messageId) {
        cache = { messageId, message: structuredClone(await store.getById(messageId)), fetchedAt: at };
      }
      return structuredClone(cache.message);
    },
    append: store.append.bind(store),
    transitionQueueCustody: store.transitionQueueCustody.bind(store),
  };
}

describe('F254 queue custody CAS contention (fan-out)', () => {
  test('six concurrent settlements sharing one messageId all commit without exhausting CAS retries', async () => {
    const queue = new InvocationQueue();
    const store = new MessageStore();
    // Custody createdAt comes from entry.createdAt (real Date.now()); the fake
    // clock must land after it or the invariant validator rejects every write.
    let fakeNow = 1_000;
    const coordinator = new QueuedMessageCustodyCoordinator({
      messageStore: staleWindowStore(store),
      now: () => fakeNow,
      // Real timers with a floor above the stale-read window: every backoff
      // retry must be able to observe the revision that won the last round.
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 20))),
    });

    const FANOUT = 6;
    const entries = [];
    for (let index = 0; index < FANOUT; index += 1) {
      const result = queue.enqueue({
        threadId: 'thread-1',
        userId: 'user-1',
        content: `fan-out target ${index}`,
        source: 'agent',
        targetCats: [`cat-${index}`],
        intent: 'investigate',
        priority: 'normal',
        ownerAuthProvenance: 'unknown',
        autoExecute: true,
      });
      assert.equal(result.outcome, 'enqueued');
      entries.push(result.entry);
    }
    const allTargetCats = entries.flatMap((entry) => entry.targetCats);

    // All fan-out entries bind the SAME trigger message → one custody revision
    // counter. The initial custody covers every target, exactly like the
    // production fan-out roll call.
    const seenInvocationIdByCatId = Object.fromEntries(allTargetCats.map((catId, index) => [catId, `inv-${index}`]));
    const fanoutEntry = {
      ...entries[0],
      targetCats: allTargetCats,
      allTargetCats,
      queuedSeenByCatIds: [...allTargetCats],
      queuedSeenInvocationIdByCatId: seenInvocationIdByCatId,
      // Each child invocation consumed the trigger body before settling —
      // settlement outcomes require these exposure witnesses.
      queuedBodyExposures: allTargetCats.map((catId, index) => ({
        targetCatId: catId,
        invocationId: `inv-${index}`,
        seenAt: 1_100,
      })),
    };
    const message = store.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: '@everyone roll call',
      mentions: allTargetCats,
      timestamp: 1_000,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(fanoutEntry),
    });
    for (const entry of entries) {
      queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);
    }
    // The enqueue results are pre-backfill snapshots (empty messageId) — re-read
    // so each concurrent settlement actually targets the shared custody.
    const settledEntries = entries.map((entry) => queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id));

    // Concurrent settlement per entry (per-entry locks do not serialize across
    // siblings) — each commit CASes the shared message custody revision.
    // Entry createdAt is Date.now()-scale; settle after it.
    fakeNow = entries[0].createdAt + 500;
    const settledAt = fakeNow;
    const outcomes = await Promise.allSettled(
      settledEntries.map((entry, index) =>
        coordinator.commitSuccessfulTargets(entry, entry.targetCats, `inv-${index}`, settledAt),
      ),
    );
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.deepEqual(
      rejected.map((outcome) => outcome.reason?.message),
      [],
      'no fan-out sibling may lose the custody CAS race',
    );

    const finalCustody = store.getById(message.id).queueCustody;
    assert.equal(finalCustody.status, 'terminal');
    assert.deepEqual(
      [...finalCustody.handledByCatIds].sort(),
      [...allTargetCats].sort(),
      'every fan-out target settles to handled',
    );
  });

  test('casBackoffDelayMs stays within the exponential cap for every attempt', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delay = casBackoffDelayMs(attempt);
      const cap = Math.min(25 * 2 ** attempt, 400);
      assert.ok(delay >= 0 && delay < cap, `attempt ${attempt}: ${delay} not in [0, ${cap})`);
    }
  });
});
