import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

function appendTerminal(
  f: Fixture,
  input: { threadId?: string; timestamp: number; content?: string } = { timestamp: f.service.now() + 1 },
) {
  return f.messages.append({
    userId: f.actor.userId,
    from: { kind: 'agent', catId: f.actor.catId },
    threadId: input.threadId ?? f.child.id,
    content: input.content ?? 'Original terminal result persisted before the owner registered its successor return',
    mentions: [],
    timestamp: input.timestamp,
  });
}

function createNextExecution(f: Fixture) {
  const task = f.tasks.get(f.input.taskId);
  assert.ok(task.entrustedWork?.developmentScope);
  const proposal = f.proposals.create({
    sourceThreadId: f.actor.threadId,
    sourceCatId: f.actor.catId,
    sourceInvocationId: 'successor-execution',
    sourceMessageId: f.source.id,
    title: 'Next approved execution',
    reason: 'Continue the accepted Task in another child',
    parentThreadId: f.actor.threadId,
    preferredCats: [f.actor.catId],
    projectPath: process.cwd(),
    createdBy: f.actor.userId,
    reportingMode: 'final-only',
    subjectTaskId: task.id,
    approvedDevelopmentScope: task.entrustedWork.developmentScope,
  });
  const child = f.threads.create(f.actor.userId, 'Next execution', process.cwd(), f.actor.threadId, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: f.actor.threadId,
    approvedBy: f.actor.userId,
    approvedAt: f.service.now(),
  });
  f.proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: f.actor.userId });
  f.proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
  return child;
}

async function deadlineThenPersistTerminal(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t),
    first = await f.service.register(f.actor, f.input, 'strict');
  f.tick(20_000);
  await f.runner.triggerNow(first.registrationId);
  assert.equal(f.service.read(first.registrationId)?.status, 'delivered');
  assert.equal(f.service.read(first.registrationId)?.reason, 'deadline_review');
  const predecessorWake = f.messages.getById(f.wakes[0]?.[4]);
  assert.ok(predecessorWake);
  const terminal = appendTerminal(f, { timestamp: Math.max(f.service.now() + 1, predecessorWake.timestamp + 1) });
  f.tick(1_000);
  const successor = await f.service.register(
    f.actor,
    {
      ...f.input,
      predecessorRegistrationId: first.registrationId,
      slaUntil: f.service.now() + 30_000,
    },
    'strict',
  );
  assert.ok(terminal.timestamp < successor.registeredAt, 'the regression requires a pre-existing terminal source');
  return { f, first, predecessorWake, successor, terminal };
}

test('a successor accepts the original terminal report persisted after its predecessor deadline wake', async (t) => {
  const f = await fixture(t),
    first = await f.service.register(f.actor, f.input, 'strict');
  const stale = appendTerminal(f, {
    timestamp: f.service.now() - 1_000,
    content: 'Old execution note that predates the owner fact review',
  });
  await assert.rejects(
    f.service.report({ ...f.actor, threadId: f.child.id }, first.registrationId, {
      sourceMessageId: stale.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:stale-before-registration'],
    }),
    /current persisted terminal report/,
  );

  f.tick(20_000);
  await f.runner.triggerNow(first.registrationId);
  const predecessorWake = f.messages.getById(f.wakes[0]?.[4]);
  assert.ok(predecessorWake);
  const terminal = appendTerminal(f, { timestamp: Math.max(f.service.now() + 1, predecessorWake.timestamp + 1) });
  f.tick(1_000);
  const successor = await f.service.register(
    f.actor,
    {
      ...f.input,
      predecessorRegistrationId: first.registrationId,
      slaUntil: f.service.now() + 30_000,
    },
    'strict',
  );

  await assert.rejects(
    f.service.report({ ...f.actor, threadId: f.child.id }, successor.registrationId, {
      sourceMessageId: stale.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:stale-before-deadline'],
    }),
    /current persisted terminal report/,
  );
  const result = await f.service.report({ ...f.actor, threadId: f.child.id }, successor.registrationId, {
    sourceMessageId: terminal.id,
    outcome: 'completed',
    evidenceRefs: ['artifact:original-terminal'],
  });

  assert.equal(result.status, 'delivered');
  assert.equal(f.service.read(successor.registrationId)?.report?.sourceMessageId, terminal.id);
  assert.equal(f.wakes.length, 2, 'the deadline review and the eventual terminal report each wake the owner once');
});

test('a same-millisecond message persisted before the predecessor wake is not reclassified as terminal', async (t) => {
  const wallClock = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: wallClock });
  const f = await fixture(t),
    first = await f.service.register(f.actor, f.input, 'strict'),
    beforeWake = appendTerminal(f, {
      timestamp: wallClock,
      content: 'This note has the future wake timestamp but was persisted first',
    });
  f.tick(20_000);
  await f.runner.triggerNow(first.registrationId);
  const wake = f.messages.getById(f.wakes[0]?.[4]);
  assert.ok(wake);
  assert.equal(beforeWake.timestamp, wake.timestamp);
  assert.ok(beforeWake.id < wake.id, 'sortable ids preserve the actual persistence order inside one millisecond');
  const successor = await f.service.register(
    f.actor,
    { ...f.input, predecessorRegistrationId: first.registrationId, slaUntil: f.service.now() + 30_000 },
    'strict',
  );

  await assert.rejects(
    f.service.report({ ...f.actor, threadId: f.child.id }, successor.registrationId, {
      sourceMessageId: beforeWake.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:pre-wake-same-millisecond'],
    }),
    /current persisted terminal report/,
  );
});

test('a new execution child cannot borrow the previous child deadline wake for pre-registration speech', async (t) => {
  const f = await fixture(t),
    first = await f.service.register(f.actor, f.input, 'strict');
  f.tick(20_000);
  await f.runner.triggerNow(first.registrationId);
  const wake = f.messages.getById(f.wakes[0]?.[4]);
  assert.ok(wake);
  const nextChild = createNextExecution(f);
  const report = appendTerminal(f, {
    threadId: nextChild.id,
    timestamp: Math.max(f.service.now() + 1, wake.timestamp + 1),
    content: 'New child speech cannot inherit the old child report window',
  });
  f.tick(1_000);
  const successor = await f.service.register(
    f.actor,
    {
      ...f.input,
      executionThreadId: nextChild.id,
      sourceActionRef: `message:${f.source.id}`,
      predecessorRegistrationId: first.registrationId,
      slaUntil: f.service.now() + 30_000,
    },
    'strict',
  );

  await assert.rejects(
    f.service.report({ ...f.actor, threadId: nextChild.id }, successor.registrationId, {
      sourceMessageId: report.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:wrong-execution-window'],
    }),
    /current persisted terminal report/,
  );
});

test('a delayed successor delivery retires when its predecessor deadline wake is withdrawn', async (t) => {
  const { f, predecessorWake, successor, terminal } = await deadlineThenPersistTerminal(t);
  f.setQueueFull(true);
  await f.service.report({ ...f.actor, threadId: f.child.id }, successor.registrationId, {
    sourceMessageId: terminal.id,
    outcome: 'completed',
    evidenceRefs: ['artifact:original-terminal'],
  });
  assert.equal(f.service.read(successor.registrationId)?.status, 'delivering');
  assert.equal(f.wakes.length, 1);

  f.messages.softDelete(predecessorWake.id, f.actor.userId);
  f.setQueueFull(false);
  await f.runner.triggerNow(successor.registrationId);

  assert.equal(f.service.read(successor.registrationId)?.status, 'retired');
  assert.equal(f.wakes.length, 1, 'revoked predecessor proof cannot produce a terminal owner wake');
});

for (const mutation of ['content', 'contentBlocks'] as const) {
  test(`an edited predecessor wake ${mutation} cannot authorize a prewritten terminal report`, async (t) => {
    const { f, successor, predecessorWake, terminal } = await deadlineThenPersistTerminal(t);
    if (mutation === 'content') predecessorWake.content += ' edited after successor registration';
    else predecessorWake.contentBlocks = [{ type: 'text', text: 'changed wake body' }];

    await assert.rejects(
      f.service.report({ ...f.actor, threadId: f.child.id }, successor.registrationId, {
        sourceMessageId: terminal.id,
        outcome: 'completed',
        evidenceRefs: ['artifact:original-terminal'],
      }),
      /current persisted terminal report/,
    );
    assert.equal(f.wakes.length, 1);
  });

  test(`a delayed delivery retires after predecessor wake ${mutation} drift`, async (t) => {
    const { f, successor, predecessorWake, terminal } = await deadlineThenPersistTerminal(t);
    f.setQueueFull(true);
    await f.service.report({ ...f.actor, threadId: f.child.id }, successor.registrationId, {
      sourceMessageId: terminal.id,
      outcome: 'completed',
      evidenceRefs: ['artifact:original-terminal'],
    });
    assert.equal(f.service.read(successor.registrationId)?.status, 'delivering');

    if (mutation === 'content') predecessorWake.content += ' edited while delivery pending';
    else predecessorWake.contentBlocks = [{ type: 'text', text: 'changed wake body' }];
    f.setQueueFull(false);
    await f.runner.triggerNow(successor.registrationId);

    assert.equal(f.service.read(successor.registrationId)?.status, 'retired');
    assert.equal(f.wakes.length, 1);
  });
}
