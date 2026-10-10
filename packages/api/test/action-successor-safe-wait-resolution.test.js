/**
 * F167 carrier refresh — what a refresh that lost the race may answer.
 *
 * `resolveSafeWaitCarrier` recognises a handled carrier as refreshable, then the lease store re-checks
 * the generation and revision at commit. If the lease moved in between, the request's own observation
 * is stale, so "safe_wait" (someone else owns the carrier) is only true when the lease NOW in the
 * store actually has a live carrier. Every other outcome must be derived from that latest lease.
 *
 * Counterexample from review of #4990: a real holder cancellation lands between the recognition and
 * the commit; the lease becomes `replaceable` with no carrier at all, and the caller was told
 * `safe_wait`: a dead end presented as progress.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { actionSuccessorInvocationKeyForTarget } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { queueEntryId } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { MAX_REFRESH_ATTEMPTS, resolveSafeWaitCarrier } from '../dist/routes/callback-action-carrier-resolution.js';
import { lease, request } from './helpers/direct-action-carrier-fixtures.js';

const HOLDER = 'codex-sol';

/** A lease store whose commit answers are scripted; every call is recorded. */
function scriptedLeaseStore(...answers) {
  const calls = [];
  return {
    calls,
    async refreshHandledCarrier(leaseId, input) {
      calls.push({ leaseId, ...input });
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      return typeof answer === 'function' ? answer(calls.length) : answer;
    },
    async getSubjectTerminal() {
      return null;
    },
  };
}

/** The resolver reads Queue pending work or exact source → response → child → parent evidence. */
function carrier(current, catId, state) {
  const id = `source-${current.generation}-${catId}`;
  const scope = { userId: current.tenantScope, threadId: current.holderThreadId };
  const source = {
    id,
    ...scope,
    catId: current.predecessorCatId,
    from: { kind: 'agent', catId: current.predecessorCatId },
    content: 'Implement task',
    mentions: [catId],
    timestamp: 100,
  };
  const entry = {
    id: queueEntryId(id),
    ...scope,
    owner: { kind: 'user', userId: scope.userId },
    status: 'queued',
    targets: [catId],
    payload: { messageId: id, sourceRecordId: id },
    execution: { actionSuccessorFence: buildActionSuccessorFence(current, current.dispatchId) },
  };
  if (state === 'queued') return { source, entry };
  const childId = `child-${current.generation}-${catId}`;
  const parentId = `parent-${current.generation}-${catId}`;
  const response = {
    id: `response-${current.generation}-${catId}`,
    ...scope,
    catId,
    from: { kind: 'agent', catId },
    lifecycle: {
      kind: 'response',
      invocationId: childId,
      targetId: catId,
      inputMessageIds: [id],
      inputEntryIds: [entry.id],
      status: 'completed',
    },
  };
  source.lifecycle = {
    kind: 'input',
    orderKey: `100:${id}`,
    dispatchRefs: [{ targetId: catId, phase: 'settled', statusMessageId: response.id, dispatchedAt: 110 }],
  };
  const child = {
    invocationId: childId,
    parentInvocationId: parentId,
    ...scope,
    catId,
    status: 'succeeded',
    causal: { triggerMessageId: id },
  };
  const parent = {
    id: parentId,
    ...scope,
    targetCats: [catId],
    successfulCatIds: [catId],
    status: 'succeeded',
    idempotencyKey: actionSuccessorInvocationKeyForTarget(id, catId),
    actionLeaseCarrier: { kind: 'action_successor', leaseId: current.leaseId, generation: current.generation },
  };
  return { source, response, child, parent };
}

function resolve({ observed, messages, leaseStore }) {
  const byId = new Map(
    messages.flatMap((value) =>
      value.response
        ? [
            [value.source.id, value.source],
            [value.response.id, value.response],
          ]
        : [[value.source.id, value.source]],
    ),
  );
  const parents = new Map(messages.filter((value) => value.parent).map((value) => [value.parent.id, value.parent]));
  const children = new Map(
    messages.filter((value) => value.child).map((value) => [value.child.invocationId, value.child]),
  );
  return resolveSafeWaitCarrier({
    invocationQueue: {
      listAllDurable: async () => messages.filter((value) => value.entry).map((value) => value.entry),
    },
    messageStore: {
      getByThreadAfter: async () => messages.map((value) => value.source),
      getById: async (id) => byId.get(id) ?? null,
    },
    invocationRecordStore: { get: async (id) => parents.get(id) ?? null },
    turnExecutionStore: { get: async (id) => children.get(id) ?? null },
    leaseStore,
    lease: observed,
    admissionInput: request(observed),
    clientMessageId: 'client-message-1',
  });
}

const canceledByHolder = (current) =>
  lease({
    ...current,
    status: 'replaceable',
    revision: current.revision + 1,
    holderOutcomes: { [HOLDER]: { outcome: 'canceled', evidenceRef: 'review:concurrent-cancel', at: 250 } },
  });

describe('F167 safe_wait is only answered from the lease that is in the store now', () => {
  test('a holder cancellation that lands between recognition and commit is refused, never safe_wait', async () => {
    const observed = lease();
    const latest = canceledByHolder(observed);
    const leaseStore = scriptedLeaseStore({ outcome: 'stale_revision', lease: latest });

    const resolution = await resolve({ observed, messages: [carrier(observed, HOLDER, 'handled')], leaseStore });

    assert.equal(resolution.kind, 'respond');
    assert.equal(resolution.statusCode, 409);
    assert.equal(resolution.body.status, 'action_carrier_unavailable');
    assert.equal(resolution.body.reason, 'lease_changed');
    assert.equal(resolution.body.actionLease.status, 'replaceable', 'the caller is shown the lease that is current');
    assert.equal(leaseStore.calls.length, 1, 'a lease that is no longer refreshable is not retried');
  });

  test('a concurrent refresh whose carrier is live is the one case that really is safe_wait', async () => {
    const observed = lease();
    const winner = lease({ generation: 2, revision: observed.revision + 1, dispatchId: 'post:winner-dispatch' });
    const leaseStore = scriptedLeaseStore({ outcome: 'stale_generation', lease: winner });

    const resolution = await resolve({
      observed,
      messages: [carrier(observed, HOLDER, 'handled'), carrier(winner, HOLDER, 'queued')],
      leaseStore,
    });

    assert.equal(resolution.kind, 'respond');
    assert.equal(resolution.statusCode, undefined);
    assert.equal(resolution.body.status, 'safe_wait');
    assert.equal(resolution.body.actionLease.generation, 2, 'safe_wait names the generation that is actually live');
  });

  test('a concurrent refresh that committed but has not persisted its carrier yet is carrier_missing, not safe_wait', async () => {
    const observed = lease();
    const winner = lease({ generation: 2, revision: observed.revision + 1, dispatchId: 'post:winner-dispatch' });
    const leaseStore = scriptedLeaseStore({ outcome: 'stale_generation', lease: winner });

    const resolution = await resolve({ observed, messages: [carrier(observed, HOLDER, 'handled')], leaseStore });

    assert.equal(resolution.kind, 'respond');
    assert.equal(resolution.statusCode, 409);
    assert.equal(resolution.body.reason, 'carrier_missing');
    assert.equal(resolution.body.actionLease.generation, 2);
  });

  test('a winner whose run already finished is NOT refreshed a second time for the same overlapping ask', async () => {
    const observed = lease();
    const winner = lease({ generation: 2, revision: observed.revision + 1, dispatchId: 'post:winner-dispatch' });
    const leaseStore = scriptedLeaseStore({ outcome: 'stale_generation', lease: winner });
    const resolution = await resolve({
      observed,
      messages: [carrier(observed, HOLDER, 'handled'), carrier(winner, HOLDER, 'handled')],
      leaseStore,
    });

    assert.equal(resolution.kind, 'respond');
    assert.equal(resolution.statusCode, 409);
    assert.equal(resolution.body.reason, 'lease_changed');
    assert.equal(resolution.body.actionLease.generation, 2);
    assert.equal(leaseStore.calls.length, 1, 'no second refresh commit was attempted');
  });

  test('a harmless revision bump on the same generation is re-resolved and refreshed on the new revision', async () => {
    const observed = lease();
    const bumped = lease({ revision: observed.revision + 1 });
    const refreshed = lease({ generation: 2, revision: bumped.revision + 1, dispatchId: 'post:refresh-dispatch' });
    const leaseStore = scriptedLeaseStore(
      { outcome: 'stale_revision', lease: bumped },
      { outcome: 'refreshed', lease: refreshed },
    );

    const resolution = await resolve({ observed, messages: [carrier(observed, HOLDER, 'handled')], leaseStore });

    assert.equal(resolution.kind, 'continue');
    assert.equal(resolution.admissionOutcome, 'refreshed');
    assert.equal(resolution.fence.generation, 2);
    assert.deepEqual(
      leaseStore.calls.map((call) => [call.expectedGeneration, call.expectedRevision]),
      [
        [1, observed.revision],
        [1, bumped.revision],
      ],
      'the second commit is guarded by the latest revision, not the stale one',
    );
  });

  test('a lease that keeps moving is refused with lease_changed after a bounded number of attempts', async () => {
    const observed = lease();
    let revision = observed.revision;
    const leaseStore = scriptedLeaseStore(() => {
      revision += 1;
      return { outcome: 'stale_revision', lease: lease({ revision }) };
    });

    const resolution = await resolve({ observed, messages: [carrier(observed, HOLDER, 'handled')], leaseStore });

    assert.equal(resolution.kind, 'respond');
    assert.equal(resolution.statusCode, 409);
    assert.equal(resolution.body.reason, 'lease_changed');
    assert.equal(leaseStore.calls.length, MAX_REFRESH_ATTEMPTS);
  });

  test('a stranger to the stored authority still gets authority_mismatch, not lease_changed', async () => {
    const observed = lease();
    const leaseStore = scriptedLeaseStore({ outcome: 'stale_revision', lease: lease({ revision: 99 }) });

    const resolution = await resolveSafeWaitCarrier({
      messageStore: { getByThreadAfter: async () => [carrier(observed, HOLDER, 'handled')] },
      leaseStore,
      lease: observed,
      admissionInput: request(observed, { actorCatId: 'someone-else' }),
      clientMessageId: 'client-message-1',
    });

    assert.equal(resolution.body.reason, 'authority_mismatch');
    assert.equal(leaseStore.calls.length, 0);
  });
});
