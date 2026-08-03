/**
 * Red tests: cancelAll must NOT auto-resume queued entries.
 *
 * Bug: User clicks "取消" → active invocation cancelled → queue auto-resumes
 * next entry → user cancels again → loop. Thread appears dead because
 * cancel doesn't actually stop the queue.
 *
 * Root cause: QueueProcessor.onInvocationComplete treats 'canceled_by_user'
 * the same as 'succeeded' — it auto-dequeues and starts the next entry.
 * When the cancel originates from cancelAll (user intent = "stop everything"),
 * the queue should NOT auto-resume.
 *
 * Fix contract:
 * 1. cancelAll must suppress auto-resume for that thread+cat
 * 2. A completion with no restored primary may resume independent queued work
 * 3. A canceled Queue primary is restored and must not blind-spawn from cleanup
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

function stubDeps(overrides = {}) {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'msg-stub' })),
      getById: mock.fn(async () => null),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

function enqueueEntry(queue, overrides = {}) {
  const result = queue.enqueue({
    ownerAuthProvenance: 'unknown',
    threadId: 't1',
    userId: 'u1',
    content: 'hello',
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
  return result.entry;
}

describe('cancelAll must NOT auto-resume queued entries', () => {
  let deps;
  let processor;

  beforeEach(() => {
    deps = stubDeps();
    processor = new QueueProcessor(deps);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 1: After suppressAutoResume, onInvocationComplete('canceled_by_user')
  // must NOT start the next queued entry.
  // ─────────────────────────────────────────────────────────────────────────
  it('canceled_by_user does NOT auto-resume when suppressAutoResume is active', async () => {
    // Enqueue two entries — first is "processing", second is "queued"
    const entry1 = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry1.id, 'msg-1');
    const entry2 = enqueueEntry(deps.queue, { content: 'second' });
    deps.queue.backfillMessageId('t1', 'u1', entry2.id, 'msg-2');

    // Mark first as processing (simulates active invocation)
    deps.queue.markProcessing('t1', 'u1', entry1.id);

    // Suppress auto-resume for this thread+cat (called from cancelAll handler)
    processor.suppressAutoResume('t1', 'opus', ['inv-cancel-all']);

    // Now the invocation completes with canceled_by_user
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-cancel-all', []);

    // INVARIANT: the second entry must NOT have been picked up
    // (entry1 may still show as "processing" since we called onInvocationComplete
    // directly without the full execution path removing it)
    const remaining = deps.queue.list('t1', 'u1');
    const entry2Status = remaining.find((e) => e.id === entry2.id);
    assert.ok(entry2Status, 'entry2 should still exist in queue');
    assert.equal(
      entry2Status.status,
      'queued',
      'entry2 must remain queued (not picked up) — auto-resume was suppressed',
    );

    // Router should NOT have been called (no auto-resume)
    assert.equal(
      deps.router.routeExecution.mock.callCount(),
      0,
      'routeExecution must not be called when auto-resume is suppressed',
    );
  });

  it('plain canceled from a direct connector does not enter #595 recovery when force-reset suppression is active', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entry = enqueueEntry(deps.queue, { source: 'connector', content: 'managed-command completion' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-managed-command');

    processor.suppressAutoResume('t1', 'opus', ['inv-force-reset']);
    await processor.onInvocationComplete('t1', 'opus', 'canceled', 'inv-force-reset', []);

    assert.equal(
      processor.isPaused('t1', 'opus'),
      false,
      'force-reset cancellation must terminate without arming the delayed #595 restart path',
    );
    assert.equal(
      deps.router.routeExecution.mock.callCount(),
      0,
      'the preserved connector wake must remain queued until an explicit or later valid dispatch',
    );
  });

  it('a late-bound direct connector identity makes an ID-less cancel-all fence consumable', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entry = enqueueEntry(deps.queue, { source: 'connector', content: 'preserved after pre-bind reset' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-pre-bind-reset');

    processor.suppressAutoResume('t1', 'opus');
    processor.bindAutoResumeSuppressionExecution('t1', 'opus', 'inv-late-bound');
    await processor.onInvocationComplete('t1', 'opus', 'canceled', 'inv-late-bound', []);
    t.mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      false,
      'the exact late-bound terminal must consume the formerly ID-less fence',
    );
    assert.equal(processor.isPaused('t1', 'opus'), false, 'the consumed stop fence must not leave a stale pause');
    assert.equal(deps.router.routeExecution.mock.callCount(), 0, 'the preserved connector wake must not auto-resume');
    assert.equal(
      deps.queue.list('t1', 'u1').find((candidate) => candidate.id === entry.id)?.status,
      'queued',
      'the connector wake remains durable for an explicit later dispatch',
    );
  });

  it('force-reset suppression disarms a #595 recovery timer that was already scheduled', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
    const entry = enqueueEntry(deps.queue, { content: 'queued before force-reset' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-before-reset');

    await processor.onInvocationComplete('t1', 'opus', 'failed');
    assert.equal(processor.isPaused('t1', 'opus'), true, 'failed completion should arm #595 recovery');

    processor.suppressAutoResume('t1', 'opus', ['inv-force-reset']);
    processor.clearPause('t1', 'opus');
    t.mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      deps.router.routeExecution.mock.callCount(),
      0,
      'a pre-armed recovery timer must not dispatch while force-reset suppression owns the slot',
    );
    assert.equal(
      deps.queue.list('t1', 'u1').find((candidate) => candidate.id === entry.id)?.status,
      'queued',
      'the preserved entry must remain durably queued after reset',
    );

    t.mock.timers.tick(50_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      deps.router.routeExecution.mock.callCount(),
      0,
      'clearing the old pause must invalidate its timer even after the suppression TTL expires',
    );
  });

  it('re-arms #595 recovery for the remaining suppression TTL when the same pause stays live', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
    const entry = enqueueEntry(deps.queue, { content: 'recover after the stop fence expires' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-recover-after-fence');

    processor.suppressAutoResume('t1', 'opus', ['inv-missing-terminal']);
    await processor.onInvocationComplete('t1', 'opus', 'failed', undefined, []);
    assert.equal(processor.isPaused('t1', 'opus'), true, 'unrelated failure should own a #595 pause generation');

    t.mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deps.router.routeExecution.mock.callCount(), 0, 'the 10-second timer must defer to the live fence');
    assert.equal(processor.isPaused('t1', 'opus'), true, 'defer must retain the same pause generation');

    t.mock.timers.tick(49_999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deps.router.routeExecution.mock.callCount(), 0, 'recovery must wait for the full suppression TTL');

    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processor.isPaused('t1', 'opus'), false, 'the same pause must retire when its fence expires');
    assert.equal(deps.router.routeExecution.mock.callCount(), 1, 'queued work must recover exactly once after expiry');
  });

  it('moves deferred #595 recovery to the renewed suppression expiry without duplicating it', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
    const entry = enqueueEntry(deps.queue, { content: 'recover after renewed fence' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-renewed-fence');

    processor.suppressAutoResume('t1', 'opus', ['inv-first-missing-terminal']);
    await processor.onInvocationComplete('t1', 'opus', 'failed', undefined, []);

    t.mock.timers.tick(5_000);
    processor.suppressAutoResume('t1', 'opus', ['inv-second-missing-terminal']);
    t.mock.timers.tick(55_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      deps.router.routeExecution.mock.callCount(),
      0,
      'renewal must move recovery to the latest fence expiry',
    );
    assert.equal(processor.isPaused('t1', 'opus'), true, 'the renewed fence must retain the same pause');

    t.mock.timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processor.isPaused('t1', 'opus'), false, 'the pause must retire at the renewed expiry');
    assert.equal(deps.router.routeExecution.mock.callCount(), 1, 'renewal must not create duplicate recovery attempts');
  });

  it('an unrelated replacement cancellation cannot consume suppression owned by cancel-all', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entry = enqueueEntry(deps.queue, { content: 'preserved by cancel-all' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-preserved');

    processor.suppressAutoResume('t1', 'opus', ['inv-canceled-by-all']);

    await processor.onInvocationComplete('t1', 'opus', 'canceled', 'inv-replacement', []);
    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      true,
      'a replacement terminal must not consume another invocation’s stop marker',
    );

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-canceled-by-all', []);
    t.mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      false,
      'the exact canceled execution terminal must consume its own marker',
    );

    assert.equal(
      deps.router.routeExecution.mock.callCount(),
      0,
      'the original cancel-all terminal must still suppress queue restart',
    );
    assert.equal(
      deps.queue.list('t1', 'u1').find((candidate) => candidate.id === entry.id)?.status,
      'queued',
      'cancel-all must preserve queued work after an unrelated replacement terminates',
    );
  });

  it('an older cancel-all terminal cannot consume a newer stop marker on the same slot', async () => {
    processor.suppressAutoResume('t1', 'opus', ['inv-old-stop']);
    processor.suppressAutoResume('t1', 'opus', ['inv-new-stop']);

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-old-stop', []);
    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      true,
      'the newer canceled execution must retain its own stop marker',
    );

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-new-stop', []);
    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      false,
      'the final matching terminal should retire the slot fence',
    );
  });

  it('an older exact terminal cannot drop a newer ID-less stop fence on the same slot', async () => {
    processor.suppressAutoResume('t1', 'opus', ['inv-old-stop']);
    processor.suppressAutoResume('t1', 'opus');

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-old-stop', []);

    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      true,
      'draining the older exact ID must preserve the newer anonymous reset fence',
    );

    processor.bindAutoResumeSuppressionExecution('t1', 'opus', 'inv-new-stop');
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-new-stop', []);
    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      false,
      'the newer fence must retire after its anonymous owner binds and reports its exact terminal',
    );
  });

  it('late-binding an anonymous fence preserves the original reset TTL', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000 });

    processor.suppressAutoResume('t1', 'opus');
    t.mock.timers.tick(30_000);
    processor.bindAutoResumeSuppressionExecution('t1', 'opus', 'inv-late-bound');
    t.mock.timers.tick(30_000);

    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      false,
      'durable identity binding must not renew a reset fence',
    );
  });

  it('connector admission suppression is bounded by the existing 60-second cancelAll TTL', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000 });

    processor.suppressAutoResume('t1', 'opus');
    assert.equal(processor.isAutoResumeSuppressed('t1', 'opus'), true);

    t.mock.timers.tick(60_000);
    assert.equal(
      processor.isAutoResumeSuppressed('t1', 'opus'),
      false,
      'a missing terminal callback must not leave connector admission fenced forever',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 2: Without suppressAutoResume, canceled_by_user SHOULD still
  // auto-resume (backward compat for single-cat cancel scenarios).
  // ─────────────────────────────────────────────────────────────────────────
  it('canceled_by_user still auto-resumes when suppressAutoResume is NOT active', async () => {
    const entry1 = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry1.id, 'msg-1');
    const entry2 = enqueueEntry(deps.queue, { content: 'second' });
    deps.queue.backfillMessageId('t1', 'u1', entry2.id, 'msg-2');

    deps.queue.markProcessing('t1', 'u1', entry1.id);

    // Do NOT call suppressAutoResume — normal cancel flow
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user');

    // entry2 should have been picked up (auto-resume is the default)
    const remaining = deps.queue.list('t1', 'u1');
    // At least one entry should be processing or the router should have been called
    assert.ok(
      deps.router.routeExecution.mock.callCount() > 0 || remaining.some((e) => e.status === 'processing'),
      'Without suppress, canceled_by_user should auto-resume the next entry',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 3: suppressAutoResume is single-use — it auto-clears after
  // one onInvocationComplete call, so subsequent completions resume normally.
  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 3 (P1 fix): cancelAll → steer → old completion must not
  // consume suppress meant for the cancelled invocation.
  //
  // Race: cancelAll sets suppress, steer starts new invocation B.
  // B completes with 'succeeded' BEFORE A completes with 'canceled_by_user'.
  // If suppress is not status-gated, B eats the flag and A auto-resumes.
  // ─────────────────────────────────────────────────────────────────────────
  it('succeeded completion does NOT consume suppress flag (race: steer after cancelAll)', async () => {
    const entry1 = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry1.id, 'msg-1');
    const entry2 = enqueueEntry(deps.queue, { content: 'second' });
    deps.queue.backfillMessageId('t1', 'u1', entry2.id, 'msg-2');
    deps.queue.markProcessing('t1', 'u1', entry1.id);

    // cancelAll sets suppress
    processor.suppressAutoResume('t1', 'opus', ['inv-cancel-all']);

    // steer's new invocation completes with 'succeeded' FIRST
    await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-steer', []);
    // Let fire-and-forget execution settle (tryExecuteNextAcrossUsers is void-chained)
    await new Promise((r) => setTimeout(r, 50));

    // Record how many route calls happened from the 'succeeded' path
    const callsFromSucceeded = deps.router.routeExecution.mock.callCount();

    // Old invocation's canceled_by_user arrives AFTER succeeded
    deps.router.routeExecution.mock.resetCalls();
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-cancel-all', []);
    await new Promise((r) => setTimeout(r, 50));

    // INVARIANT: canceled_by_user must consume the suppress and NOT auto-resume.
    // The 'succeeded' path may or may not auto-resume (it's the steer'd invocation,
    // normal behavior). But 'canceled_by_user' must NOT trigger additional auto-resume.
    assert.equal(
      deps.router.routeExecution.mock.callCount(),
      0,
      `canceled_by_user after succeeded must still be suppressed — ` +
        `flag must survive succeeded completion (succeeded called route ${callsFromSucceeded} times)`,
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RED TEST 4 (砚砚 P1): multi-cat cancelAll → secondary cat starts new
  // invocation → per-cat cancel within 60s must NOT be incorrectly suppressed.
  //
  // cancelAll fences every cancelled slot, but each marker is bound to the exact
  // execution(s) canceled. A later per-cat cancellation must not consume or obey
  // an older invocation's terminal marker.
  // ─────────────────────────────────────────────────────────────────────────
  it('multi-cat cancelAll does NOT leave stale suppress on secondary cats', async () => {
    // Simulate cancelAll fencing both slots for the old aggregate invocation.
    processor.suppressAutoResume('t1', 'opus', ['inv-old-aggregate']);
    processor.suppressAutoResume('t1', 'codex', ['inv-old-aggregate']);

    // Enqueue an entry for codex
    const codexEntry = enqueueEntry(deps.queue, { targetCats: ['codex'], content: 'codex msg' });
    deps.queue.backfillMessageId('t1', 'u1', codexEntry.id, 'msg-codex');

    // codex invocation completes with canceled_by_user (new per-cat cancel)
    await processor.onInvocationComplete('t1', 'codex', 'canceled_by_user', 'inv-new-codex', []);
    await new Promise((r) => setTimeout(r, 50));

    // INVARIANT: codex should auto-resume normally (no stale suppress)
    const remaining = deps.queue.list('t1', 'u1');
    const codexStatus = remaining.find((e) => e.id === codexEntry.id);
    assert.ok(
      deps.router.routeExecution.mock.callCount() > 0 || (codexStatus && codexStatus.status === 'processing'),
      'codex must auto-resume — no stale suppress from multi-cat cancelAll',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-042 / operator Queue correction: a canceled primary is restored to Queue.
  // Cleanup must not immediately dispatch either the same entry or a sibling;
  // a later explicit/natural dispatch owns the next attempt.
  // ─────────────────────────────────────────────────────────────────────────
  it('single-cat user_cancel restores the primary and does not blind-spawn from cleanup', async () => {
    // Override start() to return a pre-aborted controller with 'user_cancel'
    const abortedController = new AbortController();
    abortedController.abort('user_cancel');
    deps.invocationTracker.start = mock.fn(() => abortedController);
    deps.invocationTracker.startAll = mock.fn(() => abortedController);

    const entry1 = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry1.id, 'msg-1');
    const entry2 = enqueueEntry(deps.queue, { content: 'second' });
    deps.queue.backfillMessageId('t1', 'u1', entry2.id, 'msg-2');

    // Process entry1 — will detect pre-aborted controller with 'user_cancel'
    await processor.processNext('t1', 'u1');
    // Let fire-and-forget settle
    await new Promise((r) => setTimeout(r, 100));

    // Both entries remain queued. The canceled primary is still the single
    // durable carrier, and cleanup cannot bounce between retryable entries.
    const remaining = deps.queue.list('t1', 'u1');
    assert.deepEqual(
      remaining.map((entry) => [entry.id, entry.status]),
      [
        [entry1.id, 'queued'],
        [entry2.id, 'queued'],
      ],
    );
    assert.equal(deps.router.routeExecution.mock.callCount(), 1, 'cleanup must not spawn a second attempt');
  });

  it('suppressAutoResume is consumed after one use (single-shot)', async () => {
    // Suppress, then consume it with a canceled_by_user completion
    processor.suppressAutoResume('t1', 'opus', ['inv-first']);
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user', 'inv-first', []);

    // Verify suppress flag is gone by checking the internal state:
    // A second suppressAutoResume + onInvocationComplete should suppress,
    // but WITHOUT a second suppress call, it should NOT suppress.
    const entry = enqueueEntry(deps.queue, { content: 'after-suppress' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-3');

    // This completion should auto-resume (no suppress active)
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    // entry should have been picked up (auto-resume is back to normal)
    const remaining = deps.queue.list('t1', 'u1');
    const entryStatus = remaining.find((e) => e.id === entry.id);
    // Either entry is now processing, or routeExecution was called
    assert.ok(
      deps.router.routeExecution.mock.callCount() > 0 || (entryStatus && entryStatus.status === 'processing'),
      'After suppress is consumed, subsequent completions should auto-resume normally',
    );
  });
});
