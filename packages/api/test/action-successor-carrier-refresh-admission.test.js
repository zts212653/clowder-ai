/**
 * F167 carrier refresh — the admission step between "this carrier is refreshable" and the route
 * persisting a replacement carrier. It builds the transition input from the INCOMING request, asks
 * the lease store to commit it, and names exactly one of: refreshed, superseded (someone else
 * changed the lease first), subject_terminal, or rejected.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { refreshHandledActionSuccessorCarrier } from '../dist/domains/ball-custody/ActionSuccessorCarrierRefresh.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  canonicalizeActionIdentity,
  refreshHandledActionSuccessor,
} from '../dist/domains/ball-custody/action-successor-state-machine.js';

const SUBJECT = 'subject:task:task-4058';

function lease(overrides = {}) {
  return {
    leaseId: 'lease-4058',
    ...canonicalizeActionIdentity({
      tenantScope: 'user-1',
      subjectRef: SUBJECT,
      actionFamily: 'implement',
      successorSlot: 'implementer',
    }),
    mode: 'single',
    holderCatIds: ['codex-sol'],
    dispatchId: 'post:original-dispatch',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-holder',
    predecessorCatId: 'codex-astra',
    predecessorThreadId: 'thread-holder',
    issuerStandingEvidenceRef: 'callback:old-invocation:original-dispatch',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef: SUBJECT,
      predicate: { kind: 'task_done' },
    }),
    evidenceRefs: ['callback:old-invocation:original-dispatch'],
    returnTransitions: [],
    revision: 7,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function admissionInput(overrides = {}) {
  return {
    tenantScope: 'user-1',
    actorCatId: 'codex-astra',
    sourceThreadId: 'thread-holder',
    targetThreadId: 'thread-holder',
    holderCatIds: ['codex-sol'],
    dispatchId: 'post:refresh-dispatch',
    evidenceRef: 'callback:new-invocation:refresh-dispatch',
    now: 300,
    action: {
      subjectRef: SUBJECT,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      terminalPredicate: { kind: 'task_done' },
    },
    ...overrides,
  };
}

/** A lease store whose refresh runs the real state machine over a mutable current lease. */
function storeOver(initial, { subjectTerminalAfterRead = false, afterRead } = {}) {
  let current = initial;
  const calls = [];
  return {
    calls,
    get current() {
      return current;
    },
    async refreshHandledCarrier(leaseId, input) {
      calls.push({ leaseId, input });
      assert.equal(leaseId, current.leaseId);
      const result = refreshHandledActionSuccessor(current, input);
      afterRead?.();
      if (subjectTerminalAfterRead) return { outcome: 'subject_terminal', lease: current };
      if (result.outcome === 'refreshed') current = result.lease;
      return result;
    },
  };
}

describe('F167 refreshHandledActionSuccessorCarrier', () => {
  test('commits the transition from the incoming request and returns the NEW generation fence', async () => {
    const observed = lease();
    const store = storeOver(observed);

    const result = await refreshHandledActionSuccessorCarrier({
      leaseStore: store,
      lease: observed,
      admissionInput: admissionInput(),
    });

    assert.equal(result.outcome, 'refreshed');
    assert.equal(result.lease.generation, 2);
    assert.deepEqual(result.fence, buildActionSuccessorFence(result.lease, 'post:refresh-dispatch'));
    assert.equal(result.fence.generation, 2);
    assert.equal(result.fence.dispatchId, 'post:refresh-dispatch');
    assert.equal(result.fence.terminalPredicateDigest, observed.terminalPredicate.digest);

    // The transition input is built from the request and the observed lease, never from guesses.
    assert.deepEqual(store.calls[0].input, {
      expectedGeneration: 1,
      expectedRevision: 7,
      predecessorCatId: 'codex-astra',
      predecessorThreadId: 'thread-holder',
      holderCatIds: ['codex-sol'],
      holderThreadId: 'thread-holder',
      mode: 'single',
      parallelIntent: undefined,
      terminalPredicateDigest: observed.terminalPredicate.digest,
      dispatchId: 'post:refresh-dispatch',
      evidenceRef: 'callback:new-invocation:refresh-dispatch',
      now: 300,
    });
  });

  test('two concurrent refreshes of the same observed lease: exactly one wins, the other is superseded', async () => {
    const observed = lease();
    const store = storeOver(observed);

    const [first, second] = [
      await refreshHandledActionSuccessorCarrier({
        leaseStore: store,
        lease: observed,
        admissionInput: admissionInput({ dispatchId: 'post:first', evidenceRef: 'callback:a:first' }),
      }),
      await refreshHandledActionSuccessorCarrier({
        leaseStore: store,
        lease: observed,
        admissionInput: admissionInput({ dispatchId: 'post:second', evidenceRef: 'callback:b:second' }),
      }),
    ];

    assert.equal(first.outcome, 'refreshed');
    assert.equal(second.outcome, 'superseded');
    assert.equal(second.lease.generation, 2);
    assert.equal(second.lease.dispatchId, 'post:first');
    assert.equal(store.current.generation, 2);
  });

  test('a lease that changed under the observation (same generation, new revision) is superseded, not refreshed', async () => {
    const observed = lease();
    const store = storeOver({ ...observed, revision: 8 });
    const result = await refreshHandledActionSuccessorCarrier({
      leaseStore: store,
      lease: observed,
      admissionInput: admissionInput(),
    });
    assert.equal(result.outcome, 'superseded');
    assert.equal(store.current.generation, 1);
  });

  test('a subject that turned terminal before the commit surfaces as subject_terminal', async () => {
    const observed = lease();
    const result = await refreshHandledActionSuccessorCarrier({
      leaseStore: storeOver(observed, { subjectTerminalAfterRead: true }),
      lease: observed,
      admissionInput: admissionInput(),
    });
    assert.equal(result.outcome, 'subject_terminal');
    assert.equal(result.lease, observed);
  });

  test('every other refusal is rejected with its precise reason and the lease untouched', async () => {
    const cases = {
      holder_outcome_present: lease({
        holderOutcomes: { 'codex-sol': { outcome: 'rejected_ownership', evidenceRef: 'e', at: 1 } },
      }),
      lease_not_active: lease({ status: 'replaceable' }),
      not_direct_carrier: lease({ dispatchDeliveryState: 'delivered' }),
    };
    for (const [reason, observed] of Object.entries(cases)) {
      const store = storeOver(observed);
      const result = await refreshHandledActionSuccessorCarrier({
        leaseStore: store,
        lease: observed,
        admissionInput: admissionInput(),
      });
      assert.deepEqual({ outcome: result.outcome, reason: result.reason }, { outcome: 'rejected', reason });
      assert.equal(store.current, observed);
    }
  });

  test('an incoming identity that is not the stored authority is rejected, including a different actor or holder', async () => {
    const observed = lease();
    const drift = [
      { actorCatId: 'opus' },
      { holderCatIds: ['kimi'] },
      { targetThreadId: 'thread-elsewhere' },
      { action: { ...admissionInput().action, subjectRef: 'subject:task:other-task' } },
      { action: { ...admissionInput().action, terminalPredicate: undefined } },
    ];
    for (const change of drift) {
      const store = storeOver(observed);
      const result = await refreshHandledActionSuccessorCarrier({
        leaseStore: store,
        lease: observed,
        admissionInput: admissionInput(change),
      });
      assert.equal(result.outcome, 'rejected', JSON.stringify(change));
      assert.equal(store.current, observed, JSON.stringify(change));
    }
  });
});
