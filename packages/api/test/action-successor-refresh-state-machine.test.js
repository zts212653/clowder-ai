/**
 * F167 carrier refresh — the pure lease transition.
 *
 * A direct action carrier whose invocation finished normally is `handled`, but the Task is still
 * open, so its lease stays active with no outcome. The predecessor then has no governed way to hand
 * the same work to the same holder again. `refreshHandledActionSuccessor` is the authoritative
 * transition that does it: it advances the generation, because the carrier idempotency key
 * (`action:<leaseId>:<generation>:<catId>`) is what makes the Queue/InvocationRecord layer start a
 * fresh execution instead of skipping the old, completed one.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  canonicalizeActionIdentity,
  carrierRefreshEvidenceRef,
  claimActionSuccessor,
  isCarrierRefreshGeneration,
  refreshHandledActionSuccessor,
} from '../dist/domains/ball-custody/action-successor-state-machine.js';
import { actionSuccessorInvocationIdempotencyKey } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { actionSuccessorCarrierKey } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';

const SUBJECT = 'subject:task:task-4058';
const PREDICATE = canonicalizeActionTerminalPredicate({
  actionFamily: 'implement',
  subjectRef: SUBJECT,
  predicate: { kind: 'task_done' },
});

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
    terminalPredicate: PREDICATE,
    evidenceRefs: ['callback:old-invocation:original-dispatch'],
    returnTransitions: [],
    revision: 7,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function request(current, overrides = {}) {
  return {
    expectedGeneration: current.generation,
    expectedRevision: current.revision,
    predecessorCatId: current.predecessorCatId,
    predecessorThreadId: current.predecessorThreadId,
    holderCatIds: [...current.holderCatIds],
    holderThreadId: current.holderThreadId,
    mode: current.mode,
    parallelIntent: current.parallelIntent,
    terminalPredicateDigest: current.terminalPredicate?.digest,
    dispatchId: 'post:refresh-dispatch',
    evidenceRef: 'callback:new-invocation:refresh-dispatch',
    now: 300,
    ...overrides,
  };
}

describe('F167 refreshHandledActionSuccessor', () => {
  test('advances an active, outcome-free direct lease one generation and keeps every identity field', () => {
    const current = lease();
    const result = refreshHandledActionSuccessor(current, request(current));

    assert.equal(result.outcome, 'refreshed');
    const next = result.lease;
    assert.equal(next.generation, 2);
    assert.equal(next.revision, 8);
    assert.equal(next.updatedAt, 300);
    assert.equal(next.dispatchId, 'post:refresh-dispatch');
    assert.equal(next.status, 'active');
    assert.deepEqual(next.holderOutcomes, {});
    assert.deepEqual(next.completionCandidates, {});
    for (const field of [
      'leaseId',
      'key',
      'tenantScope',
      'subjectRef',
      'actionFamily',
      'successorSlot',
      'mode',
      'claimOrigin',
      'holderThreadId',
      'predecessorCatId',
      'predecessorThreadId',
      'createdAt',
    ]) {
      assert.deepEqual(next[field], current[field], `${field} must not change`);
    }
    assert.deepEqual(next.holderCatIds, current.holderCatIds);
    assert.deepEqual(next.terminalPredicate, current.terminalPredicate);
    assert.equal(next.dispatchDeliveryState, undefined);
  });

  test('the new generation yields a different carrier key and a different InvocationRecord key', () => {
    const current = lease();
    const { lease: next } = refreshHandledActionSuccessor(current, request(current));
    const fence = (l) => ({ leaseId: l.leaseId, generation: l.generation, dispatchId: l.dispatchId });

    const oldCarrierKey = actionSuccessorCarrierKey(fence(current), 'codex-sol');
    const newCarrierKey = actionSuccessorCarrierKey(fence(next), 'codex-sol');
    assert.equal(oldCarrierKey, 'action:lease-4058:1:codex-sol');
    assert.equal(newCarrierKey, 'action:lease-4058:2:codex-sol');
    // The old record is `succeeded`, which is not replayable: only a different key starts new work.
    assert.notEqual(
      actionSuccessorInvocationIdempotencyKey(newCarrierKey),
      actionSuccessorInvocationIdempotencyKey(oldCarrierKey),
    );
  });

  test('the new issuer standing is this request, and the old one stays in the evidence history', () => {
    const current = lease();
    const { lease: next } = refreshHandledActionSuccessor(current, request(current));
    assert.equal(next.issuerStandingEvidenceRef, 'callback:new-invocation:refresh-dispatch');
    assert.ok(next.evidenceRefs.includes('callback:old-invocation:original-dispatch'));
    assert.ok(next.evidenceRefs.includes('callback:new-invocation:refresh-dispatch'));
  });

  test('the refreshed generation carries a durable marker; the original generation does not', () => {
    const current = lease();
    const { lease: next } = refreshHandledActionSuccessor(current, request(current));
    assert.equal(carrierRefreshEvidenceRef('lease-4058', 2), 'carrier-refresh:lease-4058:g2');
    assert.equal(isCarrierRefreshGeneration(next), true);
    assert.equal(isCarrierRefreshGeneration(current), false);
    // A later generation produced some other way is not mistaken for a refresh.
    assert.equal(isCarrierRefreshGeneration({ ...next, generation: 3 }), false);
  });

  test('a same-request retry after the commit is a replay through the existing claim path, not a second refresh', () => {
    const current = lease();
    const { lease: next } = refreshHandledActionSuccessor(current, request(current));
    // This is exactly what ActionSuccessorAdmissionService.admit() builds for a retry of the same call.
    const retry = claimActionSuccessor(next, {
      leaseId: 'fresh-uuid-ignored-on-replay',
      tenantScope: next.tenantScope,
      subjectRef: next.subjectRef,
      actionFamily: next.actionFamily,
      successorSlot: next.successorSlot,
      mode: next.mode,
      holderCatIds: [...next.holderCatIds],
      dispatchId: 'post:refresh-dispatch',
      claimOrigin: 'structured_transfer',
      holderThreadId: next.holderThreadId,
      predecessorCatId: next.predecessorCatId,
      predecessorThreadId: next.predecessorThreadId,
      issuerStandingEvidenceRef: 'callback:new-invocation:refresh-dispatch',
      evidenceRefs: [],
      terminalPredicate: next.terminalPredicate,
      now: 301,
    });
    assert.equal(retry.outcome, 'replayed');
    assert.equal(retry.lease.generation, 2);

    // And the transition itself refuses to run twice against the generation it already advanced.
    const second = refreshHandledActionSuccessor(next, request(current, { dispatchId: 'post:another' }));
    assert.equal(second.outcome, 'stale_generation');
    assert.equal(second.lease, next);
  });

  test('a stale generation or revision is rejected without touching the lease', () => {
    const current = lease();
    const staleGeneration = refreshHandledActionSuccessor(current, request(current, { expectedGeneration: 0 }));
    assert.equal(staleGeneration.outcome, 'stale_generation');
    assert.equal(staleGeneration.lease, current);

    const staleRevision = refreshHandledActionSuccessor(current, request(current, { expectedRevision: 6 }));
    assert.equal(staleRevision.outcome, 'stale_revision');
    assert.equal(staleRevision.lease, current);
  });

  test('only an active lease can be refreshed', () => {
    for (const status of ['replaceable', 'completed']) {
      const current = lease({ status });
      const result = refreshHandledActionSuccessor(current, request(current));
      assert.equal(result.outcome, 'lease_not_active', status);
      assert.equal(result.lease, current);
    }
  });

  test('approved-proposal, existing-standing and predicate-less leases are not direct carriers', () => {
    const cases = {
      'approved proposal delivery': lease({ dispatchDeliveryState: 'delivered' }),
      'pending approved dispatch': lease({ dispatchDeliveryState: 'pending' }),
      'existing standing': lease({
        claimOrigin: 'existing_standing',
        predecessorCatId: undefined,
        predecessorThreadId: undefined,
      }),
      'legacy predicate absent': lease({
        terminalPredicateState: { kind: 'legacy_predicate_absent' },
        terminalPredicate: undefined,
      }),
    };
    for (const [name, current] of Object.entries(cases)) {
      const result = refreshHandledActionSuccessor(current, request(current, { terminalPredicateDigest: 'x' }));
      assert.equal(result.outcome, 'not_direct_carrier', name);
      assert.equal(result.lease, current);
    }
  });

  test('any holder outcome (including a rejected-ownership return), completion candidate or return history blocks it', () => {
    const outcome = lease({
      holderOutcomes: { 'codex-sol': { outcome: 'rejected_ownership', evidenceRef: 'e', at: 1 } },
    });
    assert.equal(refreshHandledActionSuccessor(outcome, request(outcome)).outcome, 'holder_outcome_present');

    const candidate = lease({
      completionCandidates: {
        'codex-sol': { catId: 'codex-sol', candidateRevision: 1, evidenceDigest: 'd', evidenceRefs: [], recordedAt: 1 },
      },
    });
    assert.equal(refreshHandledActionSuccessor(candidate, request(candidate)).outcome, 'completion_candidate_present');

    const returned = lease({ returnTransitions: [{ generation: 1 }] });
    assert.equal(refreshHandledActionSuccessor(returned, request(returned)).outcome, 'return_present');

    const returning = lease({ returnDeliveryState: 'pending' });
    assert.equal(refreshHandledActionSuccessor(returning, request(returning)).outcome, 'return_present');
  });

  test('the incoming identity is re-asserted at the transition: no field can drift between classification and commit', () => {
    const current = lease();
    const drift = {
      'predecessor cat': { predecessorCatId: 'someone-else' },
      'predecessor thread': { predecessorThreadId: 'thread-elsewhere' },
      'holder set': { holderCatIds: ['codex-sol', 'extra'] },
      'other holder': { holderCatIds: ['codex'] },
      'holder thread': { holderThreadId: 'thread-elsewhere' },
      mode: { mode: 'parallel' },
      'parallel intent': { parallelIntent: 'invented' },
    };
    for (const [name, change] of Object.entries(drift)) {
      const result = refreshHandledActionSuccessor(current, request(current, change));
      assert.equal(result.outcome, 'authority_mismatch', name);
      assert.equal(result.lease, current, name);
    }
    const predicate = refreshHandledActionSuccessor(current, request(current, { terminalPredicateDigest: 'other' }));
    assert.equal(predicate.outcome, 'terminal_predicate_mismatch');
    assert.equal(predicate.lease, current);
  });

  test('the dispatch identity must be new and of the same origin kind as the lease', () => {
    const current = lease();
    const same = refreshHandledActionSuccessor(current, request(current, { dispatchId: current.dispatchId }));
    assert.equal(same.outcome, 'dispatch_unchanged');
    assert.equal(same.lease, current);

    // Same-thread leases are minted by `post:`; a `cross-post:` id cannot refresh them.
    const wrongKind = refreshHandledActionSuccessor(current, request(current, { dispatchId: 'cross-post:other' }));
    assert.equal(wrongKind.outcome, 'authority_mismatch');

    const crossThread = lease({ predecessorThreadId: 'thread-source', dispatchId: 'cross-post:original' });
    const crossOk = refreshHandledActionSuccessor(crossThread, request(crossThread, { dispatchId: 'cross-post:next' }));
    assert.equal(crossOk.outcome, 'refreshed');
    const crossWrong = refreshHandledActionSuccessor(crossThread, request(crossThread, { dispatchId: 'post:next' }));
    assert.equal(crossWrong.outcome, 'authority_mismatch');
  });
});
