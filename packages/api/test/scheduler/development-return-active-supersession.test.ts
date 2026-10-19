import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVELOPMENT_RETURN_TEMPLATE_ID } from '@cat-cafe/shared';
import { canonicalizeActionTerminalPredicate } from '../../src/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  claimActionSuccessor,
  recordActionSuccessorOutcome,
  recoverOrphanActionSuccessorCarrier,
  replaceActionSuccessor,
} from '../../src/domains/ball-custody/action-successor-state-machine.js';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.js';
import { prepareDevelopmentReturn } from '../../src/infrastructure/scheduler/development-return/DevelopmentReturnAuthority.js';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';
import { DynamicTaskStore as V46Store } from '../helpers/development-return-v46/DynamicTaskStore.js';

const ORIGINAL_DELEGATE_CAT = 'codex6-luna';
const SUCCESSOR_CAT = 'codex61-sol';
const LATER_SUCCESSOR_CAT = 'kimi';

function initialReplacementLease(f: Awaited<ReturnType<typeof fixture>>) {
  const subjectRef = `subject:task:${f.input.taskId}`;
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef,
    predicate: { kind: 'task_done' },
  });
  const delegateEvidenceRef =
    `proposal:${f.child.createdFromProposalId}` + `:approved:thread:${f.child.id}:cat:${ORIGINAL_DELEGATE_CAT}`;
  const claimed = claimActionSuccessor(null, {
    leaseId: 'lease-active-development-return-supersession',
    tenantScope: f.actor.userId,
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [ORIGINAL_DELEGATE_CAT],
    holderThreadId: f.child.id,
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    dispatchId: 'dispatch:initial-development-delegate',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:initial-development-delegate',
    evidenceRefs: [delegateEvidenceRef],
    terminalPredicate,
    now: f.service.now() - 100,
  }).lease;
  const terminal = recordActionSuccessorOutcome(claimed, {
    generation: 1,
    catId: ORIGINAL_DELEGATE_CAT,
    outcome: 'unavailable',
    evidenceRef: 'queue:initial-delegate-terminal-without-execution',
    now: f.service.now() - 80,
  });
  const humanEvidenceRef = `human-reassignment:message:direct-correction:sha256:${'d'.repeat(64)}`;
  const replaced = replaceActionSuccessor(terminal, {
    expectedGeneration: 1,
    holderCatIds: [SUCCESSOR_CAT],
    holderThreadId: f.child.id,
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    dispatchId: 'dispatch:human-reassigned-development-delegate',
    terminalPredicate,
    evidenceRef: 'callback:owner:human-reassignment',
    freshnessEvidenceRef: `task:${f.input.taskId}:active:1`,
    delegateEvidenceRef: humanEvidenceRef,
    now: f.service.now() - 60,
  });
  assert.equal(replaced.outcome, 'replaced');
  return replaced.lease;
}

function initialOrphanRecoveryLease(f: Awaited<ReturnType<typeof fixture>>) {
  const subjectRef = `subject:task:${f.input.taskId}`;
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef,
    predicate: { kind: 'task_done' },
  });
  const delegateEvidenceRef =
    `proposal:${f.child.createdFromProposalId}` + `:approved:thread:${f.child.id}:cat:${ORIGINAL_DELEGATE_CAT}`;
  const claimed = claimActionSuccessor(null, {
    leaseId: 'lease-active-development-return-orphan-recovery',
    tenantScope: f.actor.userId,
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [ORIGINAL_DELEGATE_CAT],
    holderThreadId: f.child.id,
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    dispatchId: 'cross-post:legacy-orphan-development-delegate',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'callback:legacy-orphan-development-delegate',
    evidenceRefs: [delegateEvidenceRef],
    terminalPredicate,
    now: f.service.now() - 100,
  }).lease;
  const recovered = recoverOrphanActionSuccessorCarrier(claimed, {
    expectedGeneration: claimed.generation,
    expectedRevision: claimed.revision,
    taskId: f.input.taskId,
    taskRevision: f.input.expectedRevision,
    sourceMessageId: 'message:legacy-orphan-development-delegate',
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    holderCatId: ORIGINAL_DELEGATE_CAT,
    holderThreadId: f.child.id,
    dispatchId: 'cross-post:recovered-orphan-development-delegate',
    evidenceRef: 'callback:recovered-orphan-development-delegate',
    now: f.service.now() - 60,
  });
  assert.equal(recovered.outcome, 'recovered');
  return recovered.lease;
}

function installLease(f: Awaited<ReturnType<typeof fixture>>, lease: ReturnType<typeof initialReplacementLease>) {
  const mutableDeps = f.service.deps as typeof f.service.deps & {
    actionSuccessors: { get(leaseId: string): Promise<typeof lease | null> };
  };
  mutableDeps.actionSuccessors = {
    async get(leaseId) {
      return leaseId === lease.leaseId ? lease : null;
    },
  };
}

function successorInput(
  f: Awaited<ReturnType<typeof fixture>>,
  predecessorRegistrationId: string,
  lease: ReturnType<typeof initialReplacementLease>,
) {
  return {
    ...f.input,
    predecessorRegistrationId,
    sourceActionRef: `action-lease:${lease.leaseId}:${lease.generation}`,
    slaUntil: f.input.slaUntil + 30_000,
  };
}

test('current g2 atomically supersedes the active g1 return and becomes the only reporter', async (t) => {
  const f = await fixture(t, {
    ownerCatId: 'codex-astra',
    proposalDelegateCatId: ORIGINAL_DELEGATE_CAT,
    catAuthoredProposalSource: true,
    proposalTriggerCatId: 'codex-sol',
  });
  const first = await f.service.register(f.actor, f.input, 'strict');
  assert.equal(first.status, 'waiting');
  assert.deepEqual(first.reporterCatIds, [ORIGINAL_DELEGATE_CAT]);
  const lease = initialReplacementLease(f);
  installLease(f, lease);
  const input = successorInput(f, first.registrationId, lease);

  const next = await f.service.register(f.actor, input, 'strict');
  const replay = await f.service.register(f.actor, input, 'strict');

  assert.equal(replay.registrationId, next.registrationId);
  assert.equal(f.service.read(first.registrationId)?.status, 'retired');
  assert.equal(f.service.read(first.registrationId)?.reason, 'superseded');
  assert.equal(f.service.read(next.registrationId)?.status, 'waiting');
  assert.deepEqual(next.reporterCatIds, [SUCCESSOR_CAT]);
  assert.equal(next.predecessorRegistrationId, first.registrationId);
  assert.equal(f.runner.getRegisteredTasks().includes(first.registrationId), false);
  assert.equal(f.runner.getRegisteredTasks().includes(next.registrationId), true);
  const all = f.service.readForActor(f.actor) as Array<{ registrationId: string; status: string }>;
  assert.equal(all.filter((state) => !['retired', 'delivered'].includes(state.status)).length, 1);

  const restartedStore = new DynamicTaskStore(f.db);
  assert.equal(restartedStore.getPrivateExecutionReturn(first.registrationId)?.reason, 'superseded');
  assert.equal(restartedStore.getPrivateExecutionReturn(next.registrationId)?.status, 'waiting');
  assert.deepEqual(
    restartedStore
      .getEnabled()
      .filter((definition) => definition.templateId === 'development-terminal-return')
      .map((d) => d.id),
    [next.registrationId],
  );
  const oldBinaryStore = new V46Store(f.db);
  assert.equal(oldBinaryStore.getPrivateExecutionReturn(first.registrationId), null);
  assert.equal(oldBinaryStore.getPrivateExecutionReturn(next.registrationId), null);
  assert.equal(oldBinaryStore.getById(next.registrationId)?.enabled, false);
});

test('orphan-recovered g2 atomically supersedes the active g1 return registration', async (t) => {
  const f = await fixture(t, {
    ownerCatId: 'codex-astra',
    proposalDelegateCatId: ORIGINAL_DELEGATE_CAT,
    catAuthoredProposalSource: true,
    proposalTriggerCatId: 'codex-sol',
  });
  const first = await f.service.register(f.actor, f.input, 'strict');
  assert.equal(first.status, 'waiting');
  const lease = initialOrphanRecoveryLease(f);
  installLease(f, lease);

  const next = await f.service.register(f.actor, successorInput(f, first.registrationId, lease), 'strict');

  assert.equal(f.service.read(first.registrationId)?.status, 'retired');
  assert.equal(f.service.read(first.registrationId)?.reason, 'superseded');
  assert.equal(next.status, 'waiting');
  assert.deepEqual(next.reporterCatIds, [ORIGINAL_DELEGATE_CAT]);
  assert.equal(next.predecessorRegistrationId, first.registrationId);
  assert.equal(f.runner.getRegisteredTasks().includes(first.registrationId), false);
  assert.equal(f.runner.getRegisteredTasks().includes(next.registrationId), true);
});

test('legacy direct predecessor retires in a V46-readable shape while its fenced successor stays hidden', async (t) => {
  const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE_CAT });
  const first = await f.service.register(f.actor, f.input, 'strict');
  const lease = initialReplacementLease(f);
  installLease(f, lease);

  const next = await f.service.register(f.actor, successorInput(f, first.registrationId, lease), 'strict');
  assert.equal(f.service.read(first.registrationId)?.status, 'retired');
  assert.equal(f.service.read(first.registrationId)?.reason, undefined);
  assert.equal(f.service.read(next.registrationId)?.status, 'waiting');

  const oldBinaryStore = new V46Store(f.db);
  assert.equal(oldBinaryStore.getPrivateExecutionReturn(first.registrationId)?.status, 'retired');
  assert.equal(oldBinaryStore.getPrivateExecutionReturn(first.registrationId)?.reason, undefined);
  assert.equal(oldBinaryStore.getPrivateExecutionReturn(next.registrationId), null);
  assert.equal(oldBinaryStore.getById(next.registrationId)?.enabled, false);
});

test('a later same-child replacement atomically moves an active action-generation return', async (t) => {
  const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE_CAT, separateProposalSource: true });
  const initialReturn = await f.service.register(f.actor, f.input, 'strict');
  const leaseG2 = initialReplacementLease(f);
  installLease(f, leaseG2);
  const g2Return = await f.service.register(
    f.actor,
    successorInput(f, initialReturn.registrationId, leaseG2),
    'strict',
  );
  const terminalG2 = recordActionSuccessorOutcome(leaseG2, {
    generation: leaseG2.generation,
    catId: SUCCESSOR_CAT,
    outcome: 'failed',
    evidenceRef: 'queue:g2-terminal',
    now: f.service.now() - 40,
  });
  const delegateEvidenceRef =
    `proposal:${f.child.createdFromProposalId}` + `:approved:thread:${f.child.id}:cat:${ORIGINAL_DELEGATE_CAT}`;
  const replaced = replaceActionSuccessor(terminalG2, {
    expectedGeneration: terminalG2.generation,
    holderCatIds: [LATER_SUCCESSOR_CAT],
    holderThreadId: f.child.id,
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    dispatchId: 'dispatch:later-active-return-successor',
    terminalPredicate: terminalG2.terminalPredicate,
    evidenceRef: 'callback:owner:later-successor',
    freshnessEvidenceRef: `task:${f.input.taskId}:active:1`,
    delegateEvidenceRef,
    now: f.service.now() - 20,
  });
  assert.equal(replaced.outcome, 'replaced');
  const leaseG3 = replaced.lease;
  installLease(f, leaseG3);

  const g3Return = await f.service.register(f.actor, successorInput(f, g2Return.registrationId, leaseG3), 'strict');
  assert.equal(f.service.read(g2Return.registrationId)?.status, 'retired');
  assert.equal(f.service.read(g2Return.registrationId)?.reason, 'superseded');
  assert.equal(g3Return.status, 'waiting');
  assert.deepEqual(g3Return.reporterCatIds, [LATER_SUCCESSOR_CAT]);
  assert.equal(g3Return.predecessorRegistrationId, g2Return.registrationId);
  const all = f.service.readForActor(f.actor) as Array<{ status: string }>;
  assert.equal(all.filter((state) => !['retired', 'delivered'].includes(state.status)).length, 1);
});

test('an insertion failure rolls back the predecessor retirement', async (t) => {
  const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE_CAT, separateProposalSource: true });
  const first = await f.service.register(f.actor, f.input, 'strict');
  const lease = initialReplacementLease(f);
  installLease(f, lease);
  const input = successorInput(f, first.registrationId, lease);
  f.db.exec(`CREATE TRIGGER fail_active_return_successor BEFORE INSERT ON dynamic_task_defs
    WHEN NEW.id != '${first.registrationId}' BEGIN SELECT RAISE(ABORT, 'forced successor insert failure'); END`);

  await assert.rejects(f.service.register(f.actor, input, 'strict'), /forced successor insert failure/);
  assert.equal(f.service.read(first.registrationId)?.status, 'waiting');
  assert.equal(f.service.readForActor(f.actor).length, 1);
});

test('two active-predecessor successor inserts commit exactly one transaction', async (t) => {
  const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE_CAT, separateProposalSource: true });
  const first = await f.service.register(f.actor, f.input, 'strict');
  const lease = initialReplacementLease(f);
  installLease(f, lease);
  const input = successorInput(f, first.registrationId, lease);
  const prepared = await prepareDevelopmentReturn(f.service.deps, f.actor, input, f.service.now());
  assert.ok(prepared.predecessorSupersession);
  const registrations = [
    prepared.registration,
    { ...prepared.registration, registrationId: `${prepared.registration.registrationId}-contender` },
  ];
  const attempts = await Promise.allSettled(
    registrations.map(async (registration) => {
      await Promise.resolve();
      f.definitions.insert(
        {
          id: registration.registrationId,
          templateId: DEVELOPMENT_RETURN_TEMPLATE_ID,
          trigger: { type: 'once', fireAt: registration.slaUntil },
          params: {},
          display: { label: '等待开发结果回流', category: 'system', subjectKind: 'none' },
          deliveryThreadId: f.actor.threadId,
          createdBy: f.actor.catId,
          createdAt: new Date(f.service.now()).toISOString(),
          enabled: true,
        },
        'strict',
        registration,
        prepared.returnStorage,
        prepared.predecessorSupersession,
      );
      return registration.registrationId;
    }),
  );

  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.match(
    attempts.find((attempt) => attempt.status === 'rejected')?.reason.message,
    /predecessor changed|predecessor|successor/i,
  );
  assert.equal(f.service.read(first.registrationId)?.reason, 'superseded');
  const all = f.service.readForActor(f.actor) as Array<{ status: string }>;
  assert.equal(all.filter((state) => !['retired', 'delivered'].includes(state.status)).length, 1);
});

for (const state of ['reported', 'delivering', 'cancelled'] as const) {
  test(`an active predecessor in ${state} state cannot be superseded`, async (t) => {
    const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE_CAT, separateProposalSource: true });
    const first = await f.service.register(f.actor, f.input, 'strict');
    if (state === 'reported') {
      f.definitions.replacePrivateExecutionReturn(first.registrationId, first, {
        ...first,
        status: 'ready',
        reason: 'terminal_report',
        report: {
          sourceMessageId: 'message:already-reported',
          sourceMessageRevision: `sha256:${'e'.repeat(64)}`,
          outcome: 'completed',
          evidenceRefs: ['artifact:already-reported'],
        },
      });
    } else if (state === 'delivering') {
      f.definitions.replacePrivateExecutionReturn(first.registrationId, first, {
        ...first,
        status: 'delivering',
        reason: 'deadline_review',
        deliveryRevision: first.observedRevision,
      });
    } else {
      f.definitions.replacePrivateExecutionReturn(first.registrationId, first, {
        ...first,
        status: 'retired',
        reason: 'cancelled',
      });
    }
    const lease = initialReplacementLease(f);
    installLease(f, lease);

    await assert.rejects(
      f.service.register(f.actor, successorInput(f, first.registrationId, lease), 'strict'),
      /predecessor|active|supersed/i,
    );
    assert.equal(f.service.readForActor(f.actor).length, 1);
    assert.notEqual(f.service.read(first.registrationId)?.reason, 'superseded');
  });
}

test('a stale or mismatched lease cannot retire the active predecessor', async (t) => {
  const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE_CAT, separateProposalSource: true });
  const first = await f.service.register(f.actor, f.input, 'strict');
  const lease = initialReplacementLease(f);
  installLease(f, { ...lease, generation: lease.generation + 1 });

  await assert.rejects(
    f.service.register(f.actor, successorInput(f, first.registrationId, lease), 'strict'),
    /source|generation|unavailable|predecessor/i,
  );
  assert.equal(f.service.read(first.registrationId)?.status, 'waiting');
  assert.equal(f.service.readForActor(f.actor).length, 1);
});
