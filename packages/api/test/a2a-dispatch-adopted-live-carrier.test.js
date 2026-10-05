/**
 * F317 Live dispatch adoption: completeAdopted fence tests.
 *
 * A Live carrier invocation can complete dispatches that were not its own
 * invocation trigger, via the adopted dispatch path. This requires:
 * 1. Both isLiveCarrierInvocation and getReadEvidenceForMessage deps provided (fail-closed otherwise)
 * 2. The predicate returns true for this invocation
 * 3. Durable, invocation-bound read-evidence covers the adopted message
 * 4. The adopted source message targets this cat in this thread
 *
 * The existing complete() path must remain unchanged (regression guard).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

const SUBJECT = 'ball:thread:thread-1';
const dispositions = async (h) =>
  (await h.eventLog.read(SUBJECT)).filter((event) => event.kind === 'ball.dispatch_dispositioned');

/** Default read-evidence witness: returns evidence for any message at timestamp 1_800. */
const defaultReadEvidence = async ({ messageId }) => ({
  messageId,
  seenAt: 1_800,
  evidenceKind: 'full_contiguous_thread_context',
});

/**
 * Create a second dispatch source message (not the invocation trigger) and
 * record a handed event for it, so the adopted dispatch has a valid handoff.
 */
async function addAdoptedDispatch(h, { fromCatId = 'opus', toCatId = 'codex-sol' } = {}) {
  const msg = h.messageStore.append({
    userId: 'user-1',
    catId: createCatId(fromCatId),
    content: `@${toCatId} please handle this`,
    mentions: [createCatId(toCatId)],
    timestamp: 1_500,
    threadId: 'thread-1',
    origin: 'stream',
  });
  await h.ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      fromCatId,
      toCatId,
      messageId: msg.id,
      at: 1_500,
    }),
  );
  return msg;
}

// ─── Positive: successful adopted dispatch ─────────────────────────────────

test('completeAdopted succeeds when Live carrier + read evidence + source targets cat', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: defaultReadEvidence,
  });
  const adopted = await addAdoptedDispatch(h);

  // Auth without the adopted message as trigger (simulates Live invocation)
  const liveAuth = auth(h, {
    a2aTriggerMessageId: h.source.id,
    originTriggerMessageId: h.source.id,
  });

  const result = await h.service.completeAdopted(liveAuth, adopted.id, 'completed');

  assert.equal(result.outcome, 'applied');
  assert.equal(result.sourceMessageId, adopted.id);
  assert.equal(result.invocationId, 'inv-1');
  assert.equal(result.fromCatId, createCatId('opus'));

  // Verify adopted provenance recorded in event with real read-evidence
  const events = await dispositions(h);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload.adopted, {
    adoptedSourceMessageId: adopted.id,
    liveInvocationId: 'inv-1',
    witnessTimestamp: 1_800,
    readEvidenceKind: 'full_contiguous_thread_context',
  });
});

// ─── Negative: dep not provided → 503 ─────────────────────────────────────

test('completeAdopted throws adopted_dispatch_unavailable when isLiveCarrierInvocation dep is missing', async () => {
  const h = await harness({ getReadEvidenceForMessage: defaultReadEvidence }); // No isLiveCarrierInvocation
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_unavailable');
      return true;
    },
  );
});

test('completeAdopted throws adopted_dispatch_unavailable when getReadEvidenceForMessage dep is missing', async () => {
  const h = await harness({ isLiveCarrierInvocation: async () => true }); // No getReadEvidenceForMessage
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_unavailable');
      return true;
    },
  );
});

// ─── Negative: not a Live carrier ──────────────────────────────────────────

test('completeAdopted throws adopted_dispatch_not_live_carrier when predicate returns false', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => false,
    getReadEvidenceForMessage: defaultReadEvidence,
  });
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_not_live_carrier');
      return true;
    },
  );
});

// ─── Negative: no read evidence ───────────────────────────────────────────

test('completeAdopted throws adopted_dispatch_not_read when read evidence is missing', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: async () => null, // No evidence for this message
  });
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_not_read');
      return true;
    },
  );
});

// ─── Negative: read evidence for wrong message ──────────────────────────────

test('completeAdopted throws adopted_dispatch_not_read when evidence messageId does not match', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    // Evidence returns a different messageId than the adopted source
    getReadEvidenceForMessage: async () => ({
      messageId: 'some-other-message-id',
      seenAt: 1_800,
      evidenceKind: 'full_contiguous_thread_context',
    }),
  });
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_not_read');
      return true;
    },
  );
});

// ─── Negative: read evidence kind not in allowed set ─────────────────────────

test('completeAdopted throws adopted_dispatch_evidence_kind_rejected when kind is not allowed', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: async ({ messageId }) => ({
      messageId,
      seenAt: 1_800,
      evidenceKind: 'queue_exact_read', // Not in ALLOWED_ADOPTED_EVIDENCE_KINDS
    }),
  });
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_evidence_kind_rejected');
      return true;
    },
  );
});

// ─── Negative: read evidence before handoff (pre-dispatch read) ──────────────

test('completeAdopted throws adopted_dispatch_evidence_before_handoff when seenAt is before ball.handed', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    // Evidence at t=1_400, but ball.handed is at t=1_500 — read happened BEFORE handoff
    getReadEvidenceForMessage: async ({ messageId }) => ({
      messageId,
      seenAt: 1_400,
      evidenceKind: 'full_contiguous_thread_context',
    }),
  });
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_evidence_before_handoff');
      return true;
    },
  );
});

test('completeAdopted throws adopted_dispatch_evidence_before_handoff when seenAt equals ball.handed', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    // Evidence at t=1_500, same as ball.handed — not strictly AFTER
    getReadEvidenceForMessage: async ({ messageId }) => ({
      messageId,
      seenAt: 1_500,
      evidenceKind: 'full_contiguous_thread_context',
    }),
  });
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_evidence_before_handoff');
      return true;
    },
  );
});

// ─── Negative: non-finite seenAt bypasses temporal comparison ────────────────

test('completeAdopted throws adopted_dispatch_evidence_before_handoff when seenAt is NaN', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    // NaN <= 1500 is false, so without the isFinite guard NaN slips through
    getReadEvidenceForMessage: async ({ messageId }) => ({
      messageId,
      seenAt: NaN,
      evidenceKind: 'full_contiguous_thread_context',
    }),
  });
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_evidence_before_handoff');
      return true;
    },
  );
});

test('completeAdopted throws adopted_dispatch_evidence_before_handoff when seenAt is Infinity', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: async ({ messageId }) => ({
      messageId,
      seenAt: Infinity,
      evidenceKind: 'full_contiguous_thread_context',
    }),
  });
  const adopted = await addAdoptedDispatch(h);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_evidence_before_handoff');
      return true;
    },
  );
});

// ─── Negative: source doesn't target cat ───────────────────────────────────

test('completeAdopted rejects when adopted message targets different cat (no handoff for this cat)', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: defaultReadEvidence,
  });
  // Create a message targeting a DIFFERENT cat — no ball.handed event for codex-sol.
  // The evidence_before_handoff guard fires first: without a handoff event for
  // this cat, we don't reveal source targeting information (oracle prevention).
  const wrongTarget = h.messageStore.append({
    userId: 'user-1',
    catId: createCatId('opus'),
    content: '@sonnet please handle this',
    mentions: [createCatId('sonnet')], // targets sonnet, not codex-sol
    timestamp: 1_500,
    threadId: 'thread-1',
    origin: 'stream',
  });

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), wrongTarget.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'adopted_dispatch_evidence_before_handoff');
      return true;
    },
  );
});

test('completeAdopted throws source_mismatch when message has handoff but targets different cat', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: defaultReadEvidence,
  });
  // Create a message targeting sonnet, but WITH a ball.handed event for codex-sol
  // (simulates a system misconfiguration or manual event injection).
  // This tests the source targeting guard that runs after evidence validation.
  const wrongTarget = h.messageStore.append({
    userId: 'user-1',
    catId: createCatId('opus'),
    content: '@sonnet please handle this',
    mentions: [createCatId('sonnet')], // targets sonnet, not codex-sol
    timestamp: 1_500,
    threadId: 'thread-1',
    origin: 'stream',
  });
  // Record a ball.handed event for codex-sol (abnormal — message doesn't target codex-sol)
  await h.ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      fromCatId: 'opus',
      toCatId: 'codex-sol',
      messageId: wrongTarget.id,
      at: 1_500,
    }),
  );

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), wrongTarget.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'a2a_dispatch_disposition_source_mismatch');
      return true;
    },
  );
});

// ─── Negative: stale invocation ────────────────────────────────────────────

test('completeAdopted throws stale_invocation when registry says not latest', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: defaultReadEvidence,
  });
  const adopted = await addAdoptedDispatch(h);
  h.setLatest(false);

  await assert.rejects(
    () => h.service.completeAdopted(auth(h), adopted.id, 'completed'),
    (error) => {
      assert.equal(error.code, 'a2a_dispatch_disposition_stale_invocation');
      return true;
    },
  );
});

// ─── Regression: existing complete() path unchanged ────────────────────────

test('existing complete() path still works when adopted deps are provided', async () => {
  const calls = [];
  const h = await harness({
    isLiveCarrierInvocation: async (q) => {
      calls.push(q);
      return true;
    },
    getReadEvidenceForMessage: defaultReadEvidence,
  });

  // Regular complete (not adopted) should NOT call isLiveCarrierInvocation
  const result = await h.service.complete(auth(h), 'handled');

  assert.equal(result.outcome, 'applied');
  assert.equal(result.sourceMessageId, h.source.id);
  assert.equal(calls.length, 0, 'isLiveCarrierInvocation must not be called on regular complete');

  // Verify no adopted provenance
  const events = await dispositions(h);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.adopted, undefined);
});

// ─── Replay: adopted dispatch replays correctly ────────────────────────────

test('completeAdopted replays idempotently on second call', async () => {
  const h = await harness({
    isLiveCarrierInvocation: async () => true,
    getReadEvidenceForMessage: defaultReadEvidence,
  });
  const adopted = await addAdoptedDispatch(h);
  const liveAuth = auth(h);

  const first = await h.service.completeAdopted(liveAuth, adopted.id, 'completed');
  assert.equal(first.outcome, 'applied');

  const second = await h.service.completeAdopted(liveAuth, adopted.id, 'completed');
  assert.equal(second.outcome, 'replayed');
  assert.equal(second.sourceMessageId, adopted.id);

  // Only one event recorded
  assert.equal((await dispositions(h)).length, 1);
});
