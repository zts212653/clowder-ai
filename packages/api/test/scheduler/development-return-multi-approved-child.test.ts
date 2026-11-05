import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { ActionSubjectTruthResolver } from '../../src/domains/ball-custody/ActionSubjectTruthResolver.js';
import { ActionSuccessorAdmissionService } from '../../src/domains/ball-custody/ActionSuccessorAdmissionService.js';
import { canonicalizeActionTerminalPredicate } from '../../src/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  type ActionSuccessorLease,
  claimActionSuccessor,
  recordActionSuccessorOutcome,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} from '../../src/domains/ball-custody/action-successor-state-machine.js';
import {
  ProposalStoreDelegateProvider,
  ThreadDelegateBindingProvider,
} from '../../src/domains/ball-custody/ProposalStoreDelegateProvider.js';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';

const ORIGINAL_DELEGATE = 'sonnet';
const NEW_DELEGATE = 'codex61-sol';

async function createMultiApprovedChildScenario(t: TestContext, laterSuccessor: boolean) {
  const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE, ownerCatId: 'codex-astra' });
  const originalRegistration = await f.service.register(f.actor, f.input, 'strict');
  f.tick(20_000);
  await f.runner.triggerNow(originalRegistration.registrationId);
  assert.equal(f.service.read(originalRegistration.registrationId)?.status, 'delivered');

  const task = f.tasks.get(f.input.taskId);
  assert.ok(task?.entrustedWork);
  const oldProposal = f.proposals.listAllByThread(f.actor.threadId)[0];
  assert.ok(oldProposal?.sourceMessageId);
  const proposal = f.proposals.create({
    sourceThreadId: f.actor.threadId,
    sourceInvocationId: 'multi-approved-child-b',
    sourceMessageId: oldProposal.sourceMessageId,
    sourceCatId: f.actor.catId,
    title: 'Execution B',
    reason: 'Independently approved execution child B',
    parentThreadId: f.actor.threadId,
    preferredCats: [NEW_DELEGATE],
    subjectTaskId: task.id,
    approvedDevelopmentScope: task.entrustedWork.developmentScope,
    projectPath: process.cwd(),
    createdBy: f.actor.userId,
    reportingMode: 'final-only',
  });
  const child = f.threads.create(f.actor.userId, 'Execution B', process.cwd(), f.actor.threadId, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: f.actor.threadId,
    approvedBy: f.actor.userId,
    approvedAt: f.service.now(),
  });
  f.proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: f.actor.userId });
  f.proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });

  const subjectRef = `subject:task:${task.id}`;
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef,
    predicate: { kind: 'task_done' },
  });
  const oldDelegateEvidence = `proposal:${oldProposal.proposalId}:approved:thread:${f.child.id}:cat:${ORIGINAL_DELEGATE}`;
  const initial = claimActionSuccessor(null, {
    leaseId: 'lease-development-multi-approved-child',
    tenantScope: f.actor.userId,
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [ORIGINAL_DELEGATE],
    holderThreadId: f.child.id,
    predecessorCatId: f.actor.catId,
    predecessorThreadId: f.actor.threadId,
    dispatchId: 'dispatch:child-a',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:child-a',
    evidenceRefs: [oldDelegateEvidence],
    terminalPredicate,
    now: f.service.now() - 100,
  }).lease;
  let lease = returnActionSuccessorToPredecessor(initial, {
    expectedGeneration: initial.generation,
    rejectingCatId: ORIGINAL_DELEGATE,
    rejectingThreadId: f.child.id,
    dispatchId: 'dispatch:child-a-return',
    groundingEvidenceRef: 'message:child-a-return',
    now: f.service.now() - 50,
  }).lease;
  const store = {
    async get(id: string) {
      return id === lease.leaseId ? lease : null;
    },
    async replace(_id: string, input: Parameters<typeof replaceActionSuccessor>[1]) {
      const result = replaceActionSuccessor(lease, input);
      if (result.outcome === 'reattached' || result.outcome === 'replaced') lease = result.lease;
      return result;
    },
  };
  const delegates = new ProposalStoreDelegateProvider(
    { get: async (id) => f.proposals.get(id) },
    new ThreadDelegateBindingProvider({
      listAllByTaskThread: async (id) => f.proposals.listAllByThread(id),
    }),
  );
  const resolver = new ActionSubjectTruthResolver(
    {
      getSubjectTerminal: async () => null,
      markSubjectTerminal: async () => null,
      clearSubjectTerminal: async () => {},
    },
    {
      get: async (id) => (id === task.id ? { ...task, developmentScope: task.entrustedWork?.developmentScope } : null),
    },
    delegates,
  );
  const admission = new ActionSuccessorAdmissionService(store, resolver);

  async function admitSuccessor(catId: string, dispatchId: string, now: number) {
    return admission.admit({
      tenantScope: f.actor.userId,
      actorCatId: f.actor.catId,
      sourceThreadId: f.actor.threadId,
      targetThreadId: child.id,
      holderCatIds: [catId],
      dispatchId,
      evidenceRef: `message:${dispatchId}`,
      incomingActionLeaseRef: { leaseId: lease.leaseId, generation: lease.generation },
      now,
      action: {
        subjectRef,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'structured_transfer',
        replace: { leaseId: lease.leaseId, expectedGeneration: lease.generation },
        terminalPredicate: { kind: 'task_done' },
      },
    });
  }

  assert.equal((await admitSuccessor(NEW_DELEGATE, 'dispatch:child-b', f.service.now())).outcome, 'reattached');
  if (laterSuccessor) {
    lease = returnActionSuccessorToPredecessor(lease, {
      expectedGeneration: lease.generation,
      rejectingCatId: NEW_DELEGATE,
      rejectingThreadId: child.id,
      dispatchId: 'dispatch:child-b-return',
      groundingEvidenceRef: 'message:child-b-return',
      now: f.service.now() + 1,
    }).lease;
    assert.equal(
      (await admitSuccessor('kimi', 'dispatch:child-b-successor', f.service.now() + 2)).outcome,
      'reattached',
    );
  }

  f.service.deps.actionSuccessors = store;
  return {
    f,
    child,
    originalRegistration,
    admitSuccessor,
    currentLease: () => lease,
    replaceLease(next: ActionSuccessorLease) {
      lease = next;
    },
    registerCurrent() {
      return f.service.register(
        f.actor,
        {
          ...f.input,
          executionThreadId: child.id,
          predecessorRegistrationId: originalRegistration.registrationId,
          sourceActionRef: `action-lease:${lease.leaseId}:${lease.generation}`,
          slaUntil: f.service.now() + 30_000,
        },
        'strict',
      );
    },
  };
}

for (const laterSuccessor of [false, true]) {
  test(`approved child B keeps action-generation reporting (later successor=${laterSuccessor})`, async (t) => {
    const scenario = await createMultiApprovedChildScenario(t, laterSuccessor);
    const registration = await scenario.registerCurrent();
    const reporter = laterSuccessor ? 'kimi' : NEW_DELEGATE;
    assert.deepEqual(registration.reporterCatIds, [reporter]);

    const report = scenario.f.messages.append({
      userId: scenario.f.actor.userId,
      from: { kind: 'agent', catId: reporter },
      threadId: scenario.child.id,
      content: 'Child B actual result',
      mentions: [],
      timestamp: scenario.f.service.now() + 1,
    });
    const delivered = await scenario.f.service.report(
      { ...scenario.f.actor, catId: reporter, threadId: scenario.child.id },
      registration.registrationId,
      { sourceMessageId: report.id, outcome: 'completed', evidenceRefs: ['artifact:child-b-result'] },
    );
    assert.equal(delivered.status, 'delivered');
  });

  test(`generation drift cannot register child B reporter (later successor=${laterSuccessor})`, async (t) => {
    const scenario = await createMultiApprovedChildScenario(t, laterSuccessor);
    scenario.replaceLease({ ...scenario.currentLease(), generation: scenario.currentLease().generation + 1 });

    await assert.rejects(scenario.registerCurrent(), /unavailable|generation|lineage/i);
  });
}

test('a missing terminal replacement edge cannot register the replacement reporter', async (t) => {
  const scenario = await createMultiApprovedChildScenario(t, true);
  const current = scenario.currentLease();
  scenario.replaceLease(
    recordActionSuccessorOutcome(current, {
      generation: current.generation,
      catId: 'kimi',
      outcome: 'failed',
      evidenceRef: 'queue:multi-child:failed-kimi',
      now: scenario.f.service.now() + 3,
    }),
  );
  assert.equal(
    (await scenario.admitSuccessor('codex6-luna', 'dispatch:child-b-terminal-recovery', scenario.f.service.now() + 4))
      .outcome,
    'replaced',
  );
  assert.equal(scenario.currentLease().replacementTransitions.length, 1);
  scenario.replaceLease({ ...scenario.currentLease(), replacementTransitions: [] });

  await assert.rejects(scenario.registerCurrent(), /unavailable|generation|lineage/i);
});
