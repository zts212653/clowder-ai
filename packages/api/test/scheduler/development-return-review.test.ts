import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveGrowingSourceMessageRevision } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';

function resume(f) {
  const task = f.tasks.get(f.input.taskId);
  const message = f.messages.append({
    userId: f.actor.userId,
    threadId: f.actor.threadId,
    catId: null,
    content: '继续 Phase B',
    mentions: [],
    timestamp: f.service.now() + 1,
  });
  const result = f.tasks.transitionDevelopmentWork({
    action: 'resume',
    actor: f.actor,
    taskId: task.id,
    scope: task.entrustedWork.developmentScope,
    expectedRevision: task.entrustedWork.revision,
    sourceRef: `message:${message.id}`,
    sourceRevision: deriveGrowingSourceMessageRevision(message),
    idempotencyKey: message.id,
  });
  assert.equal(result.result, 'resumed');
  return message;
}
const report = (f, id) =>
  f.service.report({ ...f.actor, threadId: f.child.id }, id, {
    sourceMessageId: f.report().id,
    outcome: 'completed',
    evidenceRefs: ['artifact:published'],
  });

test('r1 registration survives a human resume to r2 and publication to r3', async (t) => {
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  resume(f);
  f.tasks.updateEntrustedWork(f.input.taskId, {
    expectedRevision: 2,
    status: 'doing',
    artifactRefs: ['artifact:published'],
  });
  await report(f, state.registrationId);
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0][3], /observedRevision=1.*currentRevision=3/);
  assert.equal(f.service.read(state.registrationId).status, 'delivered');
  assert.equal(f.tasks.get(f.input.taskId).entrustedWork.revision, 3);
});

test('normal revision drift after durable admission cannot fork or invalidate a retry', async (t) => {
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  const replace = f.definitions.replacePrivateExecutionReturn.bind(f.definitions);
  let crash = true;
  f.definitions.replacePrivateExecutionReturn = (id, current, next) => {
    if (next.status === 'delivered' && crash) {
      crash = false;
      throw new Error('after Dispatch');
    }
    return replace(id, current, next);
  };
  await report(f, state.registrationId);
  resume(f);
  await f.runner.triggerNow(state.registrationId);
  assert.equal(f.service.read(state.registrationId).status, 'delivered');
  assert.equal(f.wakes.length, 1);
  assert.equal(f.transport.records.size, 1);
});

test('a new execution proposal can bind the exact typed continuation source', async (t) => {
  const f = await fixture(t),
    source = resume(f);
  const proposal = f.proposals.create({
    sourceThreadId: f.actor.threadId,
    sourceCatId: f.actor.catId,
    sourceInvocationId: 'resume',
    sourceMessageId: source.id,
    title: 'Resumed execution',
    reason: 'Continue',
    parentThreadId: f.actor.threadId,
    preferredCats: [f.actor.catId],
    projectPath: process.cwd(),
    createdBy: f.actor.userId,
    reportingMode: 'final-only',
  });
  const child = f.threads.create(f.actor.userId, 'Resumed', process.cwd(), f.actor.threadId, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: f.actor.threadId,
    approvedBy: f.actor.userId,
    approvedAt: f.service.now(),
  });
  f.proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: f.actor.userId });
  f.proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
  const input = {
    ...f.input,
    expectedRevision: 2,
    executionThreadId: child.id,
    sourceActionRef: `message:${source.id}`,
  };
  const state = await f.service.register(f.actor, input, 'strict');
  assert.equal(state.sourceActionRef, `message:${source.id}`);
  assert.ok(!f.tasks.get(f.input.taskId).entrustedWork.admission.sourceRefs.includes(state.sourceActionRef));
  f.messages.softDelete(source.id, f.actor.userId);
  await assert.rejects(f.service.register(f.actor, input, 'strict'));
});

test('retirement leaves one readable original-thread notice without waking revoked work', async (t) => {
  const f = await fixture(t),
    state = await f.service.register(f.actor, f.input, 'strict');
  f.tasks.closeEntrustedWork(f.input.taskId, {
    expectedRevision: 1,
    closure: {
      state: 'satisfied',
      condition: 'Verified',
      expectedSignal: 'verified',
      evidenceRefs: ['artifact:accepted'],
    },
  });
  f.tick(20000);
  await f.runner.triggerNow(state.registrationId);
  assert.equal(f.wakes.length, 0);
  assert.equal(f.service.read(state.registrationId).status, 'retired');
  const key = `${state.registrationId}:retirement-notice`;
  const notice = f.messages.getByIdempotencyKey(f.actor.userId, f.actor.threadId, key);
  assert.ok(notice);
  assert.match(notice.content, /回流.*失效/);
  assert.deepEqual(notice.mentions, []);
  const event = f.events.find((event) => event[1] === 'connector_message');
  assert.equal(event[2].threadId, f.actor.threadId);
  assert.equal(event[2].message.id, notice.id);
});

test('retirement notice recovers after append failure and after append-before-CAS crash', async (t) => {
  for (const failure of ['append', 'commit']) {
    const f = await fixture(t),
      state = await f.service.register(f.actor, f.input, 'strict');
    f.messages.softDelete(f.input.sourceActionRef.slice('message:'.length), f.actor.userId);
    const append = f.messages.append.bind(f.messages);
    const replace = f.definitions.replacePrivateExecutionReturn.bind(f.definitions);
    let crash = true;
    f.messages.append = (input) => {
      if (failure === 'append' && crash) {
        crash = false;
        throw new Error('Message owner unavailable');
      }
      return append(input);
    };
    f.definitions.replacePrivateExecutionReturn = (id, current, next) => {
      if (failure === 'commit' && next.status === 'retired' && crash) {
        crash = false;
        throw new Error('after notice');
      }
      return replace(id, current, next);
    };
    f.tick(20000);
    await f.runner.triggerNow(state.registrationId);
    assert.equal(f.service.read(state.registrationId).status, 'delivering');
    const key = `${state.registrationId}:retirement-notice`;
    const before = f.messages.getByIdempotencyKey(f.actor.userId, f.actor.threadId, key);
    await f.runner.triggerNow(state.registrationId);
    const notice = f.messages.getByIdempotencyKey(f.actor.userId, f.actor.threadId, key);
    assert.ok(notice);
    if (before) assert.equal(notice.id, before.id);
    assert.equal(f.service.read(state.registrationId).status, 'retired');
    assert.equal(f.wakes.length, 0);
  }
});
