import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { deriveGrowingSourceMessageRevision } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { createDevelopmentReturnFixture } from './development-return-fixture.js';

export async function createDevelopmentReturnContinuationFixture(
  t: TestContext,
  returnKind: 'terminal_report' | 'deadline_review' = 'terminal_report',
) {
  const f = await createDevelopmentReturnFixture(t);
  const predecessorRegistration = await f.service.register(f.actor, f.input, 'strict');
  if (returnKind === 'terminal_report') {
    const report = f.report();
    await f.service.report({ ...f.actor, threadId: f.child.id }, predecessorRegistration.registrationId, {
      sourceMessageId: report.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:predecessor-result'],
    });
  } else {
    f.tick(20_000);
    await f.runner.triggerNow(predecessorRegistration.registrationId);
  }
  const deliveredPredecessor = f.service.read(predecessorRegistration.registrationId);
  assert.ok(deliveredPredecessor);
  assert.equal(deliveredPredecessor.status, 'delivered');
  assert.equal(deliveredPredecessor.reason, returnKind);
  const wakeMessageId = deliveredPredecessor.wakeMessageId;
  assert.ok(wakeMessageId);
  const wake = f.messages.getById(wakeMessageId);
  assert.ok(wake);
  assert.equal(wake.source?.connector, 'development-return');

  f.tasks.closeEntrustedWork(f.input.taskId, {
    expectedRevision: 1,
    closure: {
      state: 'satisfied',
      condition: 'Predecessor result accepted',
      expectedSignal: 'verified',
      evidenceRefs: ['artifact:predecessor-accepted'],
    },
  });
  const predecessorTaskRef = `task:work:${f.input.taskId}`;
  const currentHuman = f.messages.append({
    userId: f.actor.userId,
    from: { kind: 'user', userId: f.actor.userId },
    threadId: f.actor.threadId,
    content: 'Continue with the next exact work unit',
    mentions: [],
    timestamp: f.service.now() + 1,
  });
  const scope = {
    featureRef: 'feature:F310',
    phaseKey: 'C',
    workUnitRef: 'feature-phase:F310:C',
    acceptedSourceRef: 'file:docs/features/F310-growing.md',
    acceptedRevision: 'b'.repeat(40),
  };
  const admitted = f.tasks.transitionDevelopmentWork({
    action: 'admit',
    actor: f.actor,
    scope,
    sourceRef: `message:${currentHuman.id}`,
    sourceRevision: deriveGrowingSourceMessageRevision(currentHuman),
    idempotencyKey: `admit-continuation-${returnKind}`,
    predecessorTaskRef,
    contract: {
      revision: 1,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${currentHuman.id}`],
        idempotencyKey: `admit-continuation-${returnKind}`,
        receiptRef: `task:receipt:continuation:${returnKind}`,
        admittedAt: f.service.now(),
      },
      predecessorTaskRef,
      intendedOutcome: 'Continue after the accepted predecessor',
      time: {},
      artifactRefs: [],
      closure: { state: 'open', condition: 'Verified result', expectedSignal: 'verified', evidenceRefs: [] },
    },
  });
  assert.ok('task' in admitted);
  const currentTask = admitted.task;
  assert.ok(currentTask.entrustedWork?.developmentScope);

  const proposal = f.proposals.create({
    sourceThreadId: f.actor.threadId,
    sourceInvocationId: 'inv-development-return-continuation',
    sourceMessageId: wake.id,
    sourceCatId: f.actor.catId,
    title: 'Continuation execution',
    reason: 'Execute the accepted next work unit',
    parentThreadId: f.actor.threadId,
    preferredCats: [f.actor.catId],
    projectPath: process.cwd(),
    createdBy: f.actor.userId,
    reportingMode: 'final-only',
    subjectTaskId: currentTask.id,
    approvedDevelopmentScope: currentTask.entrustedWork.developmentScope,
  });
  const child = f.threads.create(f.actor.userId, 'Continuation execution', process.cwd(), f.actor.threadId, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: f.actor.threadId,
    approvedBy: f.actor.userId,
    approvedAt: Date.now(),
  });
  assert.ok(f.proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: f.actor.userId }));
  assert.ok(f.proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id }));

  return {
    ...f,
    predecessorRegistration: deliveredPredecessor,
    wake,
    currentHuman,
    currentTask,
    currentChild: child,
    currentInput: {
      action: 'register' as const,
      taskId: currentTask.id,
      expectedRevision: 1,
      executionThreadId: child.id,
      sourceActionRef: `message:${currentHuman.id}`,
      expectedSignal: 'terminal_report' as const,
      slaUntil: f.service.now() + 10_000,
    },
  };
}
