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
 * 2. Single-cat cancel (steer/preempt) should still allow auto-resume
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
    processor.suppressAutoResume('t1', 'opus');

    // Now the invocation completes with canceled_by_user
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user');

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
    processor.suppressAutoResume('t1', 'opus');

    // steer's new invocation completes with 'succeeded' FIRST
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    // Let fire-and-forget execution settle (tryExecuteNextAcrossUsers is void-chained)
    await new Promise((r) => setTimeout(r, 50));

    // Record how many route calls happened from the 'succeeded' path
    const callsFromSucceeded = deps.router.routeExecution.mock.callCount();

    // Old invocation's canceled_by_user arrives AFTER succeeded
    deps.router.routeExecution.mock.resetCalls();
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user');
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
  // Before fix: cancelAll sets suppress for ALL cancelled cats via SocketManager.
  // After fix: suppress is set internally by executeEntry only for the entry's
  // primary cat — secondary cats never get a stale suppress.
  // ─────────────────────────────────────────────────────────────────────────
  it('multi-cat cancelAll does NOT leave stale suppress on secondary cats', async () => {
    // Simulate: cancelAll cancelled [opus, codex]. Under the new design,
    // suppress is set by executeEntry (not SocketManager), so only the
    // entry's primary cat (opus) gets suppressed. Codex gets nothing.

    // Set suppress only for opus (primary) — simulates executeEntry behavior
    processor.suppressAutoResume('t1', 'opus');
    // Do NOT set suppress for codex — that's the fix

    // Enqueue an entry for codex
    const codexEntry = enqueueEntry(deps.queue, { targetCats: ['codex'], content: 'codex msg' });
    deps.queue.backfillMessageId('t1', 'u1', codexEntry.id, 'msg-codex');

    // codex invocation completes with canceled_by_user (new per-cat cancel)
    await processor.onInvocationComplete('t1', 'codex', 'canceled_by_user');
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
  // RED TEST 5 (砚砚 regression): single-cat cancel (user_cancel reason)
  // must NOT install suppress — only cancel_all should suppress.
  // executeEntry distinguishes by abort signal reason.
  // ─────────────────────────────────────────────────────────────────────────
  it('single-cat user_cancel does NOT install suppress (only cancel_all does)', async () => {
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

    // entry2 should have been auto-resumed (single-cat cancel = auto-resume)
    const remaining = deps.queue.list('t1', 'u1');
    const entry2Status = remaining.find((e) => e.id === entry2.id);
    assert.ok(
      deps.router.routeExecution.mock.callCount() > 1 || (entry2Status && entry2Status.status === 'processing'),
      'Single-cat user_cancel must still auto-resume — only cancel_all suppresses',
    );
  });

  it('suppressAutoResume is consumed after one use (single-shot)', async () => {
    // Suppress, then consume it with a canceled_by_user completion
    processor.suppressAutoResume('t1', 'opus');
    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user');

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
