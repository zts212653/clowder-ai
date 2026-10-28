import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrdinaryTaskHandoffService } from '../dist/domains/ball-custody/OrdinaryTaskHandoffService.js';
import { createTaskApprovedDelegateProvider } from '../dist/domains/ball-custody/ProposalStoreDelegateProvider.js';
import { InMemoryProposalStore } from '../dist/domains/cats/services/stores/ports/ProposalStore.js';
import { taskNativeCallbackFixture as fixture } from './helpers/task-native-callback-fixture.js';

test('real callback uses Task/Message/Queue and never a lease; target callback can complete the same Task', async (t) => {
  const f = await fixture(t);
  const response = await f.send();
  assert.equal(response.statusCode, 200, response.body);
  const id = response.json().messageId;
  assert.equal(f.tasks.get(f.task.id)?.ownerCatId, 'sonnet');
  assert.equal(f.tasks.get(f.task.id)?.lastAppliedHandoffMessageRef, `message:${id}`);
  assert.equal(f.queue.list(f.home.id, 'native-user').length, 1);
  const auth = await f.registry.create('native-user', 'sonnet', f.home.id, 'native-parent', id);
  f.turns.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: 'native-parent',
    catId: 'sonnet',
    threadId: f.home.id,
    userId: 'native-user',
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  await f.handoffs.start(
    id,
    { userId: 'native-user', catId: 'sonnet', threadId: f.home.id, invocationId: auth.invocationId },
    'native-parent',
  );
  const done = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/update-task',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload: { taskId: f.task.id, status: 'done' },
  });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(f.tasks.get(f.task.id)?.status, 'done');
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});
test('approved child can complete through the callback without moving the canonical Task', async (t) => {
  const f = await fixture(t);
  const response = await f.send({ threadId: f.child.id });
  assert.equal(response.statusCode, 200, response.body);
  const id = response.json().messageId;
  const auth = await f.registry.create('native-user', 'sonnet', f.child.id, 'child-parent', id);
  f.turns.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: 'child-parent',
    threadId: f.child.id,
    userId: 'native-user',
    catId: 'sonnet',
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  await f.handoffs.start(
    id,
    { userId: 'native-user', catId: 'sonnet', threadId: f.child.id, invocationId: auth.invocationId },
    'child-parent',
  );
  const done = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/update-task',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload: { taskId: f.task.id, status: 'done' },
  });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(f.tasks.get(f.task.id)?.ownerCatId, 'codex');
  assert.equal(f.tasks.get(f.task.id)?.threadId, f.home.id);
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});
test('retained assign_work entry reuses exact authorized Task, not a second proposal or approval card', async (t) => {
  const f = await fixture(t);
  const response = await f.send({
    threadId: f.child.id,
    effectClass: 'assign_work',
    action: undefined,
    proposedAction: f.action,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'ok');
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
  assert.equal(f.queue.list(f.child.id, 'native-user').length, 1);
  const replay = await f.send({
    threadId: f.child.id,
    effectClass: 'assign_work',
    action: undefined,
    proposedAction: f.action,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().messageId, response.json().messageId);
  assert.equal(
    (await new OrdinaryTaskHandoffService(f.handoffs.deps).apply(response.json().messageId)).kind,
    'replayed',
  );
  assert.equal(f.queue.list(f.child.id, 'native-user').length, 1);
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});
test('Task identity is not blanket authority: foreign tenant, presence-only issuer, wrong child and withdrawn source fail closed', async (t) => {
  const f = await fixture(t);
  const foreign = f.tasks.create({
    threadId: f.home.id,
    title: 'Other tenant work',
    ownerCatId: 'codex',
    userId: 'foreign',
    createdBy: 'codex',
  });
  const denied = await f.send({ action: { ...f.action, subjectRef: `subject:task:${foreign.id}` } });
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal(f.tasks.get(foreign.id)?.ownerCatId, 'codex');
  await f.threads.addParticipants(f.home.id, ['opus']);
  const outsider = await f.registry.create('native-user', 'opus', f.home.id);
  f.turns.createRunning({
    invocationId: outsider.invocationId,
    parentInvocationId: outsider.invocationId,
    userId: 'native-user',
    threadId: f.home.id,
    catId: 'opus',
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  const noStanding = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: { 'x-invocation-id': outsider.invocationId, 'x-callback-token': outsider.callbackToken },
    payload: {
      content: 'A thread participant cannot assign unrelated work',
      targetCats: ['sonnet'],
      action: f.action,
      threadId: f.child.id,
      clientMessageId: 'presence-only',
    },
  });
  assert.equal(noStanding.statusCode, 409, noStanding.body);
  const unrelated = await f.threads.create('native-user', 'No approved contract', process.cwd());
  const wrongChild = await f.send({ threadId: unrelated.id });
  assert.equal(wrongChild.statusCode, 409, wrongChild.body);
  assert.equal(f.queue.list(f.child.id, 'native-user').length, 0);
  const allowed = await f.send({ threadId: f.child.id });
  assert.equal(allowed.statusCode, 200, allowed.body);
  await f.messages.softDelete(allowed.json().messageId, 'native-user');
  const withdrawn = await new OrdinaryTaskHandoffService(f.handoffs.deps).apply(allowed.json().messageId);
  assert.equal(withdrawn.kind, 'refused');
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});
test('a later pending or rejected authorization stops recovered provider admission, rather than becoming a second approval', async (t) => {
  const f = await fixture(t);
  const response = await f.send({ threadId: f.child.id });
  assert.equal(response.statusCode, 200, response.body);
  const source = await f.messages.getById(response.json().messageId);
  const request = source.extra.taskHandoff;
  await f.proposals.create({
    proposalId: 'genuine-later-permission',
    sourceInvocationId: request.issuer.invocationId,
    sourceThreadId: f.home.id,
    targetThreadId: f.child.id,
    senderCatId: 'codex',
    ownerUserId: 'native-user',
    targetCats: ['sonnet'],
    content: 'A separate authorization is unresolved',
    proposedAction: f.action,
    createdAt: Date.now(),
  });
  assert.deepEqual(await new OrdinaryTaskHandoffService(f.handoffs.deps).apply(source.id), {
    kind: 'refused',
    reason: 'task_dispatch_authorization_blocked',
  });
  assert.deepEqual(f.counts(), { proposalCreates: 1, cards: 0, leaseCalls: 0 });
});

test('real frozen generic contract and continuation authorize the same Task child without new signatures or lease evidence', async (t) => {
  const f = await fixture(t);
  const proposals = new InMemoryProposalStore();
  const proposal = proposals.create({
    sourceThreadId: f.home.id,
    sourceInvocationId: 'original',
    sourceCatId: 'codex',
    sourceMessageId: 'human-approved-source',
    title: f.task.title,
    reason: 'Continue original accepted Task',
    parentThreadId: f.home.id,
    preferredCats: ['sonnet'],
    projectPath: process.cwd(),
    initialMessage: 'Deliver the complete original Task',
    createdBy: 'native-user',
    subjectTaskId: f.task.id,
    subjectTaskTitle: f.task.title,
    reportingMode: 'final-only',
  });
  proposals.commitEnvelope(proposal.proposalId, {
    canonicalProposalId: proposal.proposalId,
    sourceFeatureId: 'F128',
    ownerUserId: 'native-user',
    requesterCatId: 'codex',
    createdAt: proposal.createdAt,
    originRef: { kind: 'message', threadId: f.home.id, messageId: 'human-approved-source' },
    approvalCardRef: { threadId: f.home.id, messageId: 'original-approval-card' },
  });
  const child = await f.threads.create('native-user', 'Already-approved work', process.cwd(), f.home.id, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: f.home.id,
    sourceInvocationId: 'original',
    approvedBy: 'native-user',
    approvedAt: Date.now(),
  });
  proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'native-user' });
  const approved = proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
  f.handoffs.deps.delegates = createTaskApprovedDelegateProvider(proposals, f.threads);
  const beforeContinuation = await f.send({ threadId: child.id });
  assert.equal(beforeContinuation.statusCode, 409, beforeContinuation.body);
  const input = {
    proposalId: proposal.proposalId,
    taskId: f.task.id,
    clientRequestId: 'same-contract',
    actor: { userId: 'native-user', catId: 'codex', threadId: f.home.id },
  };
  const authority = { task: (id) => f.tasks.get(id), child: (id) => f.threads.get(id), implementations: () => [] };
  const continuation = proposals.continueApprovedTask(input, authority);
  assert.equal(continuation.outcome, 'continued');
  const response = await f.send({ threadId: child.id });
  assert.equal(response.statusCode, 200, response.body);
  const repeated = await f.send({ threadId: child.id });
  assert.equal(repeated.json().messageId, response.json().messageId);
  assert.equal(proposals.continueApprovedTask(input, authority).outcome, 'replayed');
  assert.equal(proposals.get(proposal.proposalId).approvedTaskContract.digest, approved.approvedTaskContract.digest);
  assert.equal(f.tasks.get(f.task.id).threadId, f.home.id);
  assert.equal(f.tasks.get(f.task.id).ownerCatId, 'codex');
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});

test('an older still-authenticated same-cat callback cannot finish after a new same-cat handoff', async (t) => {
  const f = await fixture(t);
  const sent = await f.send({ targetCats: ['codex'] });
  assert.equal(sent.statusCode, 200, sent.body);
  const source = await f.messages.getById(sent.json().messageId);
  const oldAuth = await f.registry.getRecord(source.extra.taskHandoff.issuer.invocationId);
  const old = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/update-task',
    headers: { 'x-invocation-id': oldAuth.invocationId, 'x-callback-token': oldAuth.callbackToken },
    payload: { taskId: f.task.id, status: 'done' },
  });
  assert.equal(old.statusCode, 409, old.body);
  assert.equal(f.tasks.get(f.task.id).status, 'todo');
});
