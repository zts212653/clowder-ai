import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const { replacementTransitionMatchesDelegateLineage } = await import(
  '../dist/domains/ball-custody/action-successor-delegate-lineage.js'
);
const { claimActionSuccessor, recordActionSuccessorOutcome, replaceActionSuccessor } = await import(
  '../dist/domains/ball-custody/action-successor-state-machine.js'
);

const predicate = canonicalizeActionTerminalPredicate({
  actionFamily: 'implement',
  subjectRef: 'subject:task:work-2868',
  predicate: { kind: 'task_done' },
});
const route = { ownerCatId: 'codex-sol', ownerThreadId: 'thread-source', childThreadId: 'thread-target' };

function activeLease() {
  return claimActionSuccessor(null, {
    leaseId: 'lease-transition',
    tenantScope: 'user-1',
    subjectRef: 'subject:task:work-2868',
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex-terra'],
    holderThreadId: route.childThreadId,
    predecessorCatId: route.ownerCatId,
    predecessorThreadId: route.ownerThreadId,
    dispatchId: 'dispatch-initial',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:initial',
    evidenceRefs: ['message:initial'],
    terminalPredicate: predicate,
    now: 100,
  }).lease;
}

function replacementInput(overrides = {}) {
  return {
    expectedGeneration: 1,
    holderCatIds: ['gpt52'],
    holderThreadId: route.childThreadId,
    predecessorCatId: route.ownerCatId,
    predecessorThreadId: route.ownerThreadId,
    issuerStandingEvidenceRef: 'message:replacement',
    dispatchId: 'dispatch-replacement',
    terminalPredicate: predicate,
    evidenceRef: 'message:replacement',
    freshnessEvidenceRef: 'community:subject:task:work-2868:head:a',
    delegateEvidenceRef: 'proposal:approved-reviewer',
    now: 130,
    ...overrides,
  };
}

describe('F167 durable replacement generation edges', () => {
  it('freezes terminal holder truth and rejects altered persisted lineage', () => {
    const active = activeLease();
    const terminal = recordActionSuccessorOutcome(active, {
      generation: active.generation,
      catId: 'codex-terra',
      outcome: 'unavailable',
      evidenceRef: 'runtime:quota-exhausted',
      now: 120,
    });
    const replaced = replaceActionSuccessor(terminal, replacementInput());
    assert.equal(replaced.outcome, 'replaced');
    assert.deepEqual(replaced.lease.replacementTransitions, [
      {
        fromGeneration: 1,
        toGeneration: 2,
        reason: 'holder_terminal',
        fromHolderCatIds: ['codex-terra'],
        fromHolderThreadId: route.childThreadId,
        toHolderCatIds: ['gpt52'],
        toHolderThreadId: route.childThreadId,
        issuerCatId: route.ownerCatId,
        issuerThreadId: route.ownerThreadId,
        holderOutcomes: {
          'codex-terra': { outcome: 'unavailable', evidenceRef: 'runtime:quota-exhausted', at: 120 },
        },
        evidenceRefs: [
          'runtime:quota-exhausted',
          'message:replacement',
          'community:subject:task:work-2868:head:a',
          'proposal:approved-reviewer',
        ],
        at: 130,
      },
    ]);
    const transition = replaced.lease.replacementTransitions[0];
    assert.equal(replacementTransitionMatchesDelegateLineage(transition, route), true);
    for (const altered of [
      { ...transition, issuerCatId: 'another-owner' },
      { ...transition, fromHolderCatIds: ['another-holder'] },
      { ...transition, reason: 'interrupted' },
      { ...transition, evidenceRefs: [] },
    ]) {
      assert.equal(replacementTransitionMatchesDelegateLineage(altered, route), false);
    }
  });

  it('does not grant replacement authority from a retired interruption hint', () => {
    const interrupted = replaceActionSuccessor(
      activeLease(),
      replacementInput({
        interruptedGeneration: {
          generation: 1,
          evidenceRef: 'carrier-interrupted-after-read:lease-transition:g1:codex-terra@thread-target',
        },
      }),
    );
    assert.equal(interrupted.outcome, 'proof_required');
    assert.equal(interrupted.lease.generation, 1);
    assert.deepEqual(interrupted.lease.replacementTransitions, []);
    assert.deepEqual(interrupted.lease.holderOutcomes, {});
  });
});
