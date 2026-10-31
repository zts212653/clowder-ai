import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../../src/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  type ActionSuccessorHolderOutcome,
  claimActionSuccessor,
  recordActionSuccessorOutcome,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} from '../../src/domains/ball-custody/action-successor-state-machine.js';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';

const ORIGINAL_DELEGATE = 'sonnet';
const FIRST_SUCCESSOR = 'codex61-sol';
const SECOND_SUCCESSOR = 'kimi';

const terminalGenerationCases = [
  { label: 'failed', outcome: 'failed' },
  { label: 'canceled', outcome: 'canceled' },
  { label: 'unavailable', outcome: 'unavailable' },
] satisfies Array<{ label: string; outcome: ActionSuccessorHolderOutcome }>;

for (const terminalCase of terminalGenerationCases) {
  test(`a ${terminalCase.label} successor generation remains a terminal predecessor for the next reporter`, async (t) => {
    const f = await fixture(t, { proposalDelegateCatId: ORIGINAL_DELEGATE });
    const first = await f.service.register(f.actor, f.input, 'strict');
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
      `proposal:${f.proposals.listByThread(f.actor.threadId)[0]?.proposalId}` +
      `:approved:thread:${f.child.id}:cat:${ORIGINAL_DELEGATE}`;
    const initial = claimActionSuccessor(null, {
      leaseId: `lease-development-${terminalCase.label}`,
      tenantScope: f.actor.userId,
      subjectRef,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      holderCatIds: [ORIGINAL_DELEGATE],
      holderThreadId: f.child.id,
      predecessorCatId: f.actor.catId,
      predecessorThreadId: f.actor.threadId,
      dispatchId: `dispatch:initial-${terminalCase.label}`,
      claimOrigin: 'structured_transfer',
      issuerStandingEvidenceRef: `message:initial-${terminalCase.label}`,
      evidenceRefs: [delegateEvidenceRef],
      terminalPredicate,
      now: f.service.now() - 100,
    }).lease;
    const returned = returnActionSuccessorToPredecessor(initial, {
      expectedGeneration: initial.generation,
      rejectingCatId: ORIGINAL_DELEGATE,
      rejectingThreadId: f.child.id,
      dispatchId: `dispatch:delegate-return-${terminalCase.label}`,
      groundingEvidenceRef: `message:delegate-return-${terminalCase.label}`,
      now: f.service.now() - 90,
    }).lease;
    const attached = replaceActionSuccessor(returned, {
      expectedGeneration: returned.generation,
      holderCatIds: [FIRST_SUCCESSOR],
      holderThreadId: f.child.id,
      predecessorCatId: f.actor.catId,
      predecessorThreadId: f.actor.threadId,
      dispatchId: `dispatch:first-successor-${terminalCase.label}`,
      terminalPredicate,
      evidenceRef: `message:first-successor-${terminalCase.label}`,
      freshnessEvidenceRef: `task:${f.input.taskId}:active:1`,
      delegateEvidenceRef,
      returnedHolderCatId: f.actor.catId,
      returnedHolderThreadId: f.actor.threadId,
      returnProof: { kind: 'returned_fence', leaseId: returned.leaseId, generation: returned.generation },
      now: f.service.now() - 80,
    });
    assert.equal(attached.outcome, 'reattached');

    const box = { lease: attached.lease };
    const mutableDeps = f.service.deps as typeof f.service.deps & {
      actionSuccessors: { get(leaseId: string): Promise<typeof box.lease | null> };
    };
    mutableDeps.actionSuccessors = {
      async get(leaseId) {
        return leaseId === box.lease.leaseId ? box.lease : null;
      },
    };
    const second = await f.service.register(
      f.actor,
      {
        ...f.input,
        predecessorRegistrationId: first.registrationId,
        sourceActionRef: `action-lease:${box.lease.leaseId}:${box.lease.generation}`,
        slaUntil: f.service.now() + 10_000,
      },
      'strict',
    );
    assert.deepEqual(second.reporterCatIds, [FIRST_SUCCESSOR]);

    const terminal = recordActionSuccessorOutcome(box.lease, {
      generation: box.lease.generation,
      catId: FIRST_SUCCESSOR,
      outcome: terminalCase.outcome,
      evidenceRef: `execution:first-successor:${terminalCase.outcome}`,
      now: f.service.now() + 1,
    });
    const replaced = replaceActionSuccessor(terminal, {
      expectedGeneration: terminal.generation,
      holderCatIds: [SECOND_SUCCESSOR],
      holderThreadId: f.child.id,
      predecessorCatId: f.actor.catId,
      predecessorThreadId: f.actor.threadId,
      dispatchId: `dispatch:second-successor-${terminalCase.label}`,
      terminalPredicate,
      evidenceRef: `message:second-successor-${terminalCase.label}`,
      delegateEvidenceRef,
      now: f.service.now() + 2,
    });
    assert.equal(replaced.outcome, 'replaced');
    assert.equal(replaced.lease.replacementTransitions.at(-1)?.reason, 'holder_terminal');
    box.lease = replaced.lease;

    f.tick(20_000);
    await f.runner.triggerNow(second.registrationId);
    assert.equal(f.service.read(second.registrationId)?.status, 'retired');
    assert.equal(f.service.read(second.registrationId)?.reason, 'superseded');
    assert.equal(f.wakes.length, 1, 'a terminalized carrier does not fabricate an owner-changed wake');

    const third = await f.service.register(
      f.actor,
      {
        ...f.input,
        predecessorRegistrationId: second.registrationId,
        sourceActionRef: `action-lease:${box.lease.leaseId}:${box.lease.generation}`,
        slaUntil: f.service.now() + 10_000,
      },
      'strict',
    );
    assert.deepEqual(third.reporterCatIds, [SECOND_SUCCESSOR]);

    const report = f.messages.append({
      userId: f.actor.userId,
      from: { kind: 'agent', catId: SECOND_SUCCESSOR },
      threadId: f.child.id,
      content: `Second successor completed after ${terminalCase.label}`,
      mentions: [],
      timestamp: f.service.now() + 1,
    });
    const result = await f.service.report(
      { ...f.actor, catId: SECOND_SUCCESSOR, threadId: f.child.id },
      third.registrationId,
      {
        sourceMessageId: report.id,
        outcome: 'completed',
        evidenceRefs: [`artifact:after-${terminalCase.label}`],
      },
    );
    assert.equal(result.status, 'delivered');
    assert.equal(f.wakes.length, 2);
  });
}
