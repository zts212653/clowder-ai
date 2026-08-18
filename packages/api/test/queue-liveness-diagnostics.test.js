/**
 * Contract for the Queue liveness policy: when a queue holds entries but nothing
 * is running, the operator must get a specific reason rather than silence.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CONTINUATION_DIAGNOSTIC_MESSAGE, classifyContinuationOutcome, describeContinuationOutcome, mayCommitPause } =
  await import('../dist/domains/cats/services/agents/invocation/queue-liveness-diagnostics.js');

const base = { threadId: 't1', catId: 'opus', deferredForBusySlot: 0, hasDispatchableQueued: true };

describe('queue liveness diagnostics', () => {
  it('names no_dispatchable_candidate when nothing was eligible', () => {
    const diagnostic = describeContinuationOutcome({ ...base, outcome: 'no_dispatchable_candidate' });
    assert.ok(diagnostic);
    assert.equal(diagnostic.payload.outcome, 'no_dispatchable_candidate');
    assert.equal(diagnostic.payload.deferredForBusySlot, 0);
    assert.equal(diagnostic.payload.entryId, undefined);
    assert.equal(diagnostic.message, CONTINUATION_DIAGNOSTIC_MESSAGE);
  });

  it('names all_candidate_slots_busy and reports how many were deferred', () => {
    const diagnostic = describeContinuationOutcome({
      ...base,
      outcome: 'all_candidate_slots_busy',
      deferredForBusySlot: 2,
    });
    assert.ok(diagnostic);
    assert.equal(diagnostic.payload.outcome, 'all_candidate_slots_busy');
    assert.equal(diagnostic.payload.deferredForBusySlot, 2);
  });

  it('names start_rejected and carries the exact entry that would not start', () => {
    const diagnostic = describeContinuationOutcome({ ...base, outcome: 'start_rejected', entryId: 'entry-42' });
    assert.ok(diagnostic);
    assert.equal(diagnostic.payload.outcome, 'start_rejected');
    assert.equal(diagnostic.payload.entryId, 'entry-42');
  });

  it('says nothing when the thread has nothing dispatchable', () => {
    assert.equal(
      describeContinuationOutcome({ ...base, outcome: 'no_dispatchable_candidate', hasDispatchableQueued: false }),
      null,
    );
  });

  it('classifies a scan by whether any candidate slot was busy', () => {
    assert.equal(classifyContinuationOutcome(0), 'no_dispatchable_candidate');
    assert.equal(classifyContinuationOutcome(3), 'all_candidate_slots_busy');
  });

  it('refuses to commit a pause once a replacement owner has taken the slot', () => {
    assert.equal(mayCommitPause({ supersededByReplacement: true, stillHasDispatchableQueued: true }), false);
    assert.equal(mayCommitPause({ supersededByReplacement: false, stillHasDispatchableQueued: false }), false);
    assert.equal(mayCommitPause({ supersededByReplacement: false, stillHasDispatchableQueued: true }), true);
  });
});
