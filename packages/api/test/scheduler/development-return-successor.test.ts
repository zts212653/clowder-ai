import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../../src/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  claimActionSuccessor,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} from '../../src/domains/ball-custody/action-successor-state-machine.js';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';

const ORIGINAL_DELEGATE_CAT = 'sonnet';
const SUCCESSOR_CAT = 'codex61-sol';
const SECOND_SUCCESSOR_CAT = 'kimi';

test('a terminal return registration follows the exact returned action generation, not old preferredCats', async (t) => {
  const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE_CAT, separateProposalSource: true });
  const first = await f.service.register(f.actor, f.input, 'strict');
  assert.deepEqual(first.reporterCatIds, [ORIGINAL_DELEGATE_CAT]);
  f.tick(20_000);
  await f.runner.triggerNow(first.registrationId);
  assert.equal(f.service.read(first.registrationId)?.status, 'delivered');

  const subjectRef = `subject:task:${f.input.taskId}`;
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef,
    predicate: { kind: 'task_done' },
  });
  const delegateEvidenceRef =
    `proposal:${f.child.createdFromProposalId}` + `:approved:thread:${f.child.id}:cat:${ORIGINAL_DELEGATE_CAT}`;
  const claimed = claimActionSuccessor(null, {
    leaseId: 'lease-development-successor',
    tenantScope: f.actor.userId,
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [ORIGINAL_DELEGATE_CAT],
    holderThreadId: f.child.id,
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    dispatchId: 'dispatch:initial-development',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:initial-development',
    evidenceRefs: [delegateEvidenceRef],
    terminalPredicate,
    now: f.service.now() - 100,
  }).lease;
  const returned = returnActionSuccessorToPredecessor(claimed, {
    expectedGeneration: 1,
    rejectingCatId: ORIGINAL_DELEGATE_CAT,
    rejectingThreadId: f.child.id,
    dispatchId: 'dispatch:development-returned',
    groundingEvidenceRef: 'message:old-writer-release',
    now: f.service.now() - 50,
  }).lease;
  const reattached = replaceActionSuccessor(returned, {
    expectedGeneration: 2,
    holderCatIds: [SUCCESSOR_CAT],
    holderThreadId: f.child.id,
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    dispatchId: 'dispatch:new-writer',
    terminalPredicate,
    evidenceRef: 'message:new-writer-handoff',
    freshnessEvidenceRef: `task:${f.input.taskId}:active:1`,
    delegateEvidenceRef,
    returnedHolderCatId: f.actor.catId,
    returnedHolderThreadId: f.actor.threadId,
    returnProof: { kind: 'returned_fence', leaseId: returned.leaseId, generation: returned.generation },
    now: f.service.now() - 40,
  });
  assert.equal(reattached.outcome, 'reattached');
  let currentLease = reattached.lease;
  const mutableDeps = f.service.deps as typeof f.service.deps & {
    actionSuccessors: { get(leaseId: string): Promise<typeof currentLease | null> };
  };
  mutableDeps.actionSuccessors = {
    async get(leaseId) {
      return leaseId === currentLease.leaseId ? currentLease : null;
    },
  };

  const firstSuccessorReturn = await f.service.register(
    f.actor,
    {
      ...f.input,
      predecessorRegistrationId: first.registrationId,
      sourceActionRef: `action-lease:${currentLease.leaseId}:${currentLease.generation}`,
      slaUntil: f.input.slaUntil + 30_000,
    },
    'strict',
  );
  assert.deepEqual(firstSuccessorReturn.reporterCatIds, [SUCCESSOR_CAT]);

  const returnedAgain = returnActionSuccessorToPredecessor(reattached.lease, {
    expectedGeneration: reattached.lease.generation,
    rejectingCatId: SUCCESSOR_CAT,
    rejectingThreadId: f.child.id,
    dispatchId: 'dispatch:first-successor-returned',
    groundingEvidenceRef: 'message:first-successor-release',
    now: f.service.now() - 20,
  }).lease;
  const reattachedAgain = replaceActionSuccessor(returnedAgain, {
    expectedGeneration: returnedAgain.generation,
    holderCatIds: [SECOND_SUCCESSOR_CAT],
    holderThreadId: f.child.id,
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    dispatchId: 'dispatch:second-writer',
    terminalPredicate,
    evidenceRef: 'message:second-writer-handoff',
    freshnessEvidenceRef: `task:${f.input.taskId}:active:1`,
    delegateEvidenceRef,
    returnedHolderCatId: f.actor.catId,
    returnedHolderThreadId: f.actor.threadId,
    returnProof: { kind: 'returned_fence', leaseId: returnedAgain.leaseId, generation: returnedAgain.generation },
    now: f.service.now() - 10,
  });
  assert.equal(reattachedAgain.outcome, 'reattached');
  const lease = reattachedAgain.lease;
  currentLease = lease;

  f.tick(30_000);
  await f.runner.triggerNow(firstSuccessorReturn.registrationId);
  assert.equal(f.service.read(firstSuccessorReturn.registrationId)?.status, 'retired');
  assert.equal(f.service.read(firstSuccessorReturn.registrationId)?.reason, 'superseded');
  assert.equal(f.wakes.length, 1, 'a legally returned generation does not emit a false owner_changed wake');

  const successorInput = {
    ...f.input,
    predecessorRegistrationId: firstSuccessorReturn.registrationId,
    sourceActionRef: `action-lease:${lease.leaseId}:${lease.generation}`,
    slaUntil: f.service.now() + 30_000,
  };
  const next = await f.service.register(f.actor, successorInput, 'strict');
  const duplicate = await f.service.register(f.actor, successorInput, 'strict');
  const persisted = f.db
    .prepare(
      `SELECT enabled, development_return_json, reviewed_development_return_json,
        successor_development_return_json, parent_bound_development_return_json
        FROM dynamic_task_defs WHERE id = ?`,
    )
    .get(next.registrationId) as {
    enabled: number;
    development_return_json: string | null;
    reviewed_development_return_json: string | null;
    successor_development_return_json: string | null;
    parent_bound_development_return_json: string | null;
  };

  assert.equal(duplicate.registrationId, next.registrationId);
  assert.equal(persisted.enabled, 0, 'old binaries must not schedule an action-lineage return');
  assert.equal(persisted.development_return_json, null);
  assert.equal(persisted.reviewed_development_return_json, null);
  assert.equal(persisted.successor_development_return_json, null);
  assert.ok(persisted.parent_bound_development_return_json);
  assert.equal(
    persisted.reviewed_development_return_json ?? persisted.development_return_json,
    null,
    'a V52 reader cannot see the successor registration in either private source column',
  );
  assert.deepEqual(next.reporterCatIds, [SECOND_SUCCESSOR_CAT]);
  assert.equal(next.executionThreadId, f.child.id);
  assert.equal(next.predecessorRegistrationId, firstSuccessorReturn.registrationId);
  assert.equal(
    f.service.readForActor({ ...f.actor, catId: SECOND_SUCCESSOR_CAT, threadId: f.child.id }, next.registrationId)
      .length,
    1,
  );
  assert.deepEqual(f.service.readForActor({ ...f.actor, threadId: f.child.id }, next.registrationId), []);

  const originalDelegateMessage = f.messages.append({
    userId: f.actor.userId,
    from: { kind: 'agent', catId: ORIGINAL_DELEGATE_CAT },
    threadId: f.child.id,
    content: 'Stale original delegate result',
    mentions: [],
    timestamp: f.service.now() + 1,
  });
  await assert.rejects(
    f.service.report({ ...f.actor, catId: ORIGINAL_DELEGATE_CAT, threadId: f.child.id }, next.registrationId, {
      sourceMessageId: originalDelegateMessage.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:stale-original-delegate'],
    }),
    /unavailable here/,
  );

  const oldReporterMessage = f.messages.append({
    userId: f.actor.userId,
    from: { kind: 'agent', catId: f.actor.catId },
    threadId: f.child.id,
    content: 'Stale old reporter result',
    mentions: [],
    timestamp: f.service.now() + 1,
  });
  await assert.rejects(
    f.service.report({ ...f.actor, threadId: f.child.id }, next.registrationId, {
      sourceMessageId: oldReporterMessage.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:stale-old-reporter'],
    }),
    /unavailable here/,
  );

  const previousSuccessorMessage = f.messages.append({
    userId: f.actor.userId,
    from: { kind: 'agent', catId: SUCCESSOR_CAT },
    threadId: f.child.id,
    content: 'Stale previous successor result',
    mentions: [],
    timestamp: f.service.now() + 2,
  });
  await assert.rejects(
    f.service.report({ ...f.actor, catId: SUCCESSOR_CAT, threadId: f.child.id }, next.registrationId, {
      sourceMessageId: previousSuccessorMessage.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:stale-previous-successor'],
    }),
    /unavailable here/,
  );

  const successorMessage = f.messages.append({
    userId: f.actor.userId,
    from: { kind: 'agent', catId: SECOND_SUCCESSOR_CAT },
    threadId: f.child.id,
    content: 'Current successor result',
    mentions: [],
    timestamp: f.service.now() + 3,
  });
  const task = f.tasks.get(f.input.taskId);
  assert.ok(task?.entrustedWork?.developmentScope);
  const originalScope = task.entrustedWork.developmentScope;
  task.entrustedWork.developmentScope = { ...originalScope, acceptedRevision: 'b'.repeat(40) };
  await assert.rejects(
    f.service.report({ ...f.actor, catId: SECOND_SUCCESSOR_CAT, threadId: f.child.id }, next.registrationId, {
      sourceMessageId: successorMessage.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:scope-drift'],
    }),
    /no longer current/,
  );
  task.entrustedWork.developmentScope = originalScope;
  currentLease = { ...lease, generation: lease.generation + 1 };
  await assert.rejects(
    f.service.report({ ...f.actor, catId: SECOND_SUCCESSOR_CAT, threadId: f.child.id }, next.registrationId, {
      sourceMessageId: successorMessage.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:stale-generation'],
    }),
    /no longer current/,
  );
  currentLease = lease;
  const reported = await f.service.report(
    { ...f.actor, catId: SECOND_SUCCESSOR_CAT, threadId: f.child.id },
    next.registrationId,
    {
      sourceMessageId: successorMessage.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:successor-result'],
    },
  );
  assert.equal(reported.status, 'delivered');
  assert.equal(f.service.read(next.registrationId)?.status, 'delivered');
  assert.equal(f.wakes.length, 2, 'initial deadline review and successor terminal each wake the owner once');
});
