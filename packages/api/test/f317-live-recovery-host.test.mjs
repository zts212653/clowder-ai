import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveRecoveryHost } from '../src/domains/concierge/live/host/live-recovery-host.ts';

const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: 'codex-astra',
  invocationId: 'invocation',
  callId: 'call',
  generation: 1,
};

function page(size, cursor) {
  return {
    coverage: 'source_backed_working_set',
    authority: 'reference_data_only',
    retention: 'unknown',
    providerWindow: 'unknown',
    scope,
    observedAt: Date.now(),
    continuity: { source: 'F296', contextEpoch: 1, recordVersion: 1, transitionRef: 'epoch-1' },
    tasks: {
      coverage: 'current_thread_open_work',
      items: Array.from({ length: size }, (_, index) => ({
        taskId: `task-${index}`,
        threadId: 'home',
        ownerCatId: 'codex-astra',
        status: 'doing',
        title: { text: 'A'.repeat(400), truncated: false },
        why: { text: 'B'.repeat(400), truncated: false },
        intendedOutcome: { text: 'C'.repeat(400), truncated: false },
        updatedAt: 1,
      })),
      hasMore: true,
    },
    summaries: { coverage: 'unavailable_viewer_evidence', items: [] },
    decisions: { coverage: 'producer_bounded_history', perProducerLimit: 100, items: [], hasMore: false },
    inbox: { coverage: 'canonical_queue_references', items: [], hasMore: false },
    nextCursor: cursor,
  };
}

test('recovery shrinks a whole page at the same cursor and commits only a native accepted page', async () => {
  const cursor = {
    binding: 'scope-epoch-1',
    tasks: { after: 'task-4', complete: false },
    decisions: { complete: true },
    inbox: { complete: true },
  };
  const reads = [];
  const delivered = [];
  let outcome = 'busy';
  const host = new LiveRecoveryHost({
    scope,
    reader: {
      read: async (_scope, request) => {
        reads.push({ size: request.pageSize, cursor: request.cursor });
        return page(request.pageSize, cursor);
      },
    },
    deliver: async (body) => {
      delivered.push(body);
      return outcome;
    },
    validate: async () => true,
  });
  assert.equal(host.hasPendingWake(), true);
  assert.equal(await host.atBoundary(), 'busy');
  assert.deepEqual(
    reads.map((item) => item.size),
    [8, 4],
  );
  assert.deepEqual(
    reads.map((item) => item.cursor),
    [undefined, undefined],
  );
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sourceRefs.length, 4);
  assert.match(delivered[0].text, /unavailable_viewer_evidence/);
  assert.equal(host.hasPendingWake(), false, 'busy cannot spin on its own idle tick');

  outcome = 'accepted';
  host.onUserTurn();
  assert.equal(await host.atBoundary(), 'accepted');
  assert.equal(reads.at(-1).cursor, undefined, 'busy never advanced the cursor');
  assert.equal(host.hasPendingWake(), false, 'hasMore alone cannot create another provider turn');
  assert.equal(await host.atBoundary(), 'idle');
  host.onUserTurn();
  assert.equal(await host.atBoundary(), 'accepted');
  assert.deepEqual(reads.at(-1).cursor, cursor, 'only accepted pages advance to the next cursor');
  host.close();
});

test('cancelled and oversized recovery never advance or emit a partial page', async () => {
  let release;
  let deliveryCount = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const host = new LiveRecoveryHost({
    scope,
    reader: { read: async () => pending },
    deliver: async () => {
      deliveryCount++;
      return 'accepted';
    },
    validate: async () => true,
  });
  const attempt = host.atBoundary();
  host.cancel('user_speaking');
  assert.equal(await attempt, 'cancelled');
  release(page(1, undefined));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveryCount, 0);
  host.close();

  const oversized = new LiveRecoveryHost({
    scope,
    reader: {
      read: async () => ({
        ...page(1, undefined),
        tasks: { ...page(1, undefined).tasks, items: [{ taskId: 'large', title: { text: 'X'.repeat(9000) } }] },
      }),
    },
    deliver: async () => {
      deliveryCount++;
      return 'accepted';
    },
    validate: async () => true,
  });
  assert.equal(await oversized.atBoundary(), 'unavailable');
  assert.equal(deliveryCount, 0);
  assert.equal(oversized.hasPendingWake(), false);
  oversized.close();
});

test('a user ticket consumed by a busy recovery boundary is re-woken after cancellation unwinds', async () => {
  let releaseRead;
  const pendingRead = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let wakes = 0;
  const host = new LiveRecoveryHost({
    scope,
    reader: { read: async () => pendingRead },
    deliver: async () => 'accepted',
    validate: async () => true,
    wakeNative: () => {
      wakes++;
    },
  });
  const firstBoundary = host.atBoundary();
  host.cancel('user_speaking');
  host.onUserTurn();
  const wakesAfterUser = wakes;
  assert.equal(await host.atBoundary(), 'busy');
  assert.equal(await firstBoundary, 'cancelled');
  assert.equal(host.hasPendingWake(), true);
  assert.ok(wakes > wakesAfterUser, 'the busy native wake must be retried after the old boundary exits');
  releaseRead(page(1, undefined));
  host.close();
});
