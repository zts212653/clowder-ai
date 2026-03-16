import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const { MultiMentionOrchestrator } = await import(
  '../dist/domains/cats/services/agents/routing/MultiMentionOrchestrator.js'
);

describe('MultiMentionOrchestrator', () => {
  /** @type {InstanceType<typeof MultiMentionOrchestrator>} */
  let orch;

  const catA = /** @type {any} */ ('codex');
  const catB = /** @type {any} */ ('gemini');
  const catC = /** @type {any} */ ('gpt52');
  const initiator = /** @type {any} */ ('opus');

  beforeEach(() => {
    orch = new MultiMentionOrchestrator();
  });

  // ── create ───────────────────────────────────────────────────────

  test('creates request in pending status', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'What do you think?',
      timeoutMinutes: 8,
    });
    assert.equal(req.status, 'pending');
    assert.equal(req.targets.length, 2);
    assert.equal(req.initiator, 'opus');
    assert.equal(req.callbackTo, 'opus');
    assert.ok(req.id);
    assert.ok(req.createdAt > 0);
  });

  test('rejects targets > MAX_MULTI_MENTION_TARGETS', () => {
    assert.throws(
      () =>
        orch.create({
          threadId: 'thread1',
          initiator,
          callbackTo: initiator,
          targets: [catA, catB, catC, /** @type {any} */ ('extra')],
          question: 'test',
          timeoutMinutes: 8,
        }),
      /targets/i,
    );
  });

  test('rejects empty targets', () => {
    assert.throws(
      () =>
        orch.create({
          threadId: 'thread1',
          initiator,
          callbackTo: initiator,
          targets: [],
          question: 'test',
          timeoutMinutes: 8,
        }),
      /targets/i,
    );
  });

  test('rejects timeout out of range', () => {
    assert.throws(
      () =>
        orch.create({
          threadId: 'thread1',
          initiator,
          callbackTo: initiator,
          targets: [catA],
          question: 'test',
          timeoutMinutes: 2,
        }),
      /timeout/i,
    );
    assert.throws(
      () =>
        orch.create({
          threadId: 'thread1',
          initiator,
          callbackTo: initiator,
          targets: [catA],
          question: 'test',
          timeoutMinutes: 25,
        }),
      /timeout/i,
    );
  });

  // ── idempotency ─────────────────────────────────────────────────

  test('idempotency key returns existing request', () => {
    const r1 = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
      idempotencyKey: 'key1',
    });
    const r2 = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catB],
      question: 'different',
      timeoutMinutes: 8,
      idempotencyKey: 'key1',
    });
    assert.equal(r1.id, r2.id);
  });

  test('idempotency key is scoped to thread', () => {
    const r1 = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
      idempotencyKey: 'key1',
    });
    const r2 = orch.create({
      threadId: 'thread2',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
      idempotencyKey: 'key1',
    });
    assert.notEqual(r1.id, r2.id);
  });

  // ── lifecycle ───────────────────────────────────────────────────

  test('start transitions pending → running', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    assert.equal(orch.getStatus(req.id), 'running');
  });

  test('recordResponse transitions running → partial → done', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    const s1 = orch.recordResponse(req.id, catA, 'answer A');
    assert.equal(s1, 'partial');

    const s2 = orch.recordResponse(req.id, catB, 'answer B');
    assert.equal(s2, 'done');
  });

  test('single target: running → done directly (no partial)', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    const s = orch.recordResponse(req.id, catA, 'answer');
    assert.equal(s, 'done');
  });

  test('duplicate response from same cat is ignored', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    orch.recordResponse(req.id, catA, 'answer A');
    // Same cat again — should not change status
    const s = orch.recordResponse(req.id, catA, 'answer A v2');
    assert.equal(s, 'partial');
  });

  test('response from non-target cat is ignored', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    const s = orch.recordResponse(req.id, catB, 'intruder');
    assert.equal(s, 'running');
  });

  // ── getResult ───────────────────────────────────────────────────

  test('getResult returns all responses', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    orch.recordResponse(req.id, catA, 'answer A');
    orch.recordResponse(req.id, catB, 'answer B');

    const result = orch.getResult(req.id);
    assert.equal(result.responses.length, 2);
    assert.equal(result.responses[0].catId, catA);
    assert.equal(result.responses[0].content, 'answer A');
    assert.equal(result.responses[0].status, 'received');
    assert.equal(result.responses[1].catId, catB);
  });

  test('getResult for unknown id throws', () => {
    assert.throws(() => orch.getResult('nonexistent'), /not found/i);
  });

  // ── timeout ─────────────────────────────────────────────────────

  test('handleTimeout transitions running → timeout', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    orch.handleTimeout(req.id);
    assert.equal(orch.getStatus(req.id), 'timeout');
  });

  test('handleTimeout preserves partial responses', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    orch.recordResponse(req.id, catA, 'answer A');
    orch.handleTimeout(req.id);

    const result = orch.getResult(req.id);
    assert.equal(result.request.status, 'timeout');
    assert.equal(result.responses.length, 2);
    // catA received, catB timed out
    const respA = result.responses.find((r) => r.catId === catA);
    const respB = result.responses.find((r) => r.catId === catB);
    assert.equal(respA?.status, 'received');
    assert.equal(respB?.status, 'timeout');
  });

  test('handleTimeout on terminal state is no-op', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    orch.recordResponse(req.id, catA, 'answer');
    assert.equal(orch.getStatus(req.id), 'done');

    // timeout after done — should be no-op
    orch.handleTimeout(req.id);
    assert.equal(orch.getStatus(req.id), 'done');
  });

  test('late response after timeout is ignored', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    orch.handleTimeout(req.id);

    // Late response
    const s = orch.recordResponse(req.id, catA, 'late answer');
    assert.equal(s, 'timeout'); // unchanged
  });

  // ── handleFailure ───────────────────────────────────────────────

  test('handleFailure transitions pending → failed', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.handleFailure(req.id, 'dispatch error');
    assert.equal(orch.getStatus(req.id), 'failed');
  });

  // ── findByThread ────────────────────────────────────────────────

  // ── dispatch controller tracking (P1-1 / P1-2 fix) ────────────

  test('registerDispatch + abortByThread aborts all dispatches for thread', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    orch.registerDispatch(req.id, catA, ctrlA);
    orch.registerDispatch(req.id, catB, ctrlB);

    // Both should be active
    assert.equal(orch.hasActiveDispatches('thread1'), true);
    assert.equal(orch.hasActiveDispatches('other-thread'), false);

    // Abort all dispatches for thread1
    const aborted = orch.abortByThread('thread1');
    assert.equal(aborted, 2);
    assert.equal(ctrlA.signal.aborted, true);
    assert.equal(ctrlB.signal.aborted, true);
  });

  test('unregisterDispatch removes controller from tracking', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    const ctrl = new AbortController();
    orch.registerDispatch(req.id, catA, ctrl);
    assert.equal(orch.hasActiveDispatches('thread1'), true);

    orch.unregisterDispatch(req.id, catA);
    assert.equal(orch.hasActiveDispatches('thread1'), false);

    // abortByThread should not abort the already-unregistered controller
    const aborted = orch.abortByThread('thread1');
    assert.equal(aborted, 0);
    assert.equal(ctrl.signal.aborted, false);
  });

  test('abortByThread ignores terminal requests', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    orch.recordResponse(req.id, catA, 'done'); // transitions to 'done'

    const ctrl = new AbortController();
    orch.registerDispatch(req.id, catA, ctrl);

    // Request is terminal, so abortByThread should skip it
    const aborted = orch.abortByThread('thread1');
    assert.equal(aborted, 0);
    assert.equal(ctrl.signal.aborted, false);
  });

  test('hasActiveDispatches returns false when no controllers registered', () => {
    const req = orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);
    // Request is running but no dispatch controllers registered
    assert.equal(orch.hasActiveDispatches('thread1'), false);
  });

  // ── findByThread ────────────────────────────────────────────────

  test('findActiveByThread returns active requests', () => {
    orch.create({
      threadId: 'thread1',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    const active = orch.findActiveByThread('thread1');
    assert.equal(active.length, 1);

    const empty = orch.findActiveByThread('thread999');
    assert.equal(empty.length, 0);
  });

  // --- F108: Slot-specific cancel (AC-A9) ---

  test('abortBySlot aborts only dispatches for a specific cat (F108 AC-A9)', () => {
    const req = orch.create({
      threadId: 'thread-slot-cancel',
      initiator,
      callbackTo: initiator,
      targets: [catA, catB],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    // Register dispatches
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    orch.registerDispatch(req.id, catA, ctrlA);
    orch.registerDispatch(req.id, catB, ctrlB);

    // Abort only catA
    const aborted = orch.abortBySlot('thread-slot-cancel', catA);
    assert.equal(aborted, 1, 'should abort exactly 1 dispatch');
    assert.equal(ctrlA.signal.aborted, true, 'catA controller aborted');
    assert.equal(ctrlB.signal.aborted, false, 'catB controller untouched');
  });

  test('abortBySlot returns 0 when no dispatches match', () => {
    const req = orch.create({
      threadId: 'thread-no-match',
      initiator,
      callbackTo: initiator,
      targets: [catA],
      question: 'test',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    const ctrlA = new AbortController();
    orch.registerDispatch(req.id, catA, ctrlA);

    // Try to abort catB which is not a target
    const aborted = orch.abortBySlot('thread-no-match', catB);
    assert.equal(aborted, 0);
    assert.equal(ctrlA.signal.aborted, false, 'catA should be untouched');
  });
});
