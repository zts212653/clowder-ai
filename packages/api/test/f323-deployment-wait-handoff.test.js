import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { DeploymentWaitStartGuard } from '../dist/domains/runtime-deployment/DeploymentWaitStartGuard.js';
import { handoffWaitFixture } from './helpers/f323-handoff-wait-harness.js';

function appendUserInput(h) {
  const late = h.messageStore.append({
    from: { kind: 'user', userId: h.auth.userId },
    userId: h.auth.userId,
    threadId: h.auth.threadId,
    content: 'I will reboot soon.',
    mentions: [],
    timestamp: Date.now(),
  });
  assert.equal(
    h.invocationTracker.adoptLifecycleActiveRunInputs(
      h.auth.threadId,
      h.auth.catId,
      { invocationId: h.auth.invocationId, responseMessageId: h.active().responseMessageId },
      'late-entry',
      [late.id],
    ),
    true,
  );
  return late;
}

function startGuard(h, withHandoff = true) {
  return new DeploymentWaitStartGuard({
    taskStore: h.taskStore,
    messageStore: h.messageStore,
    observationProvider: { observe: async () => h.observation },
    ...(withHandoff ? { handoffProposalStore: h.handoffProposalStore, sessionChainStore: h.sessionChainStore } : {}),
  });
}

for (const appended of [false, true]) {
  test(`approved handoff registers and wakes once with appended inputs=${appended}`, async (t) => {
    const h = await handoffWaitFixture(t, { authorization: { ownerAuthProvenance: 'strict' } });
    assert.equal(h.auth.originTriggerMessageId, undefined);
    assert.deepEqual(h.active().inputMessageIds, []);
    let late;
    if (appended) {
      late = appendUserInput(h);
    }
    const response = await h.register();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().disposition, 'registered');
    const receipt = h.taskStore.getWaitRegistration(h.task.id).receipt;
    assert.deepEqual(receipt.source, {
      kind: 'primary',
      sourceMessageId: h.origin.id,
      sessionHandoff: {
        proposalId: h.proposal.proposalId,
        continuationEntryId: h.handoffProposalStore.get(h.proposal.proposalId).continuationEntryId,
        sourceSessionId: h.session.id,
      },
    });
    assert.deepEqual(
      parseTypedWaitRegistration(JSON.stringify(receipt)),
      receipt,
      'proof survives persistent receipt encoding',
    );
    assert.notEqual(receipt.source.sourceMessageId, late?.id, 'late input never lends source authority');
    assert.equal((await h.register()).json().disposition, 'already_registered');
    assert.equal((await h.approve()).json().deduped, true);
    assert.equal(h.routeCalls(), 1);
    await h.finish();
    assert.equal((await h.ready()).kind, 'notified');
    assert.equal((await h.ready()).kind, 'deduped');
    const [wake] = h.connector.admitted(h.auth.threadId, h.auth.userId);
    assert.equal(wake.execution.ownerAuthProvenance, 'strict');
    const identity = {
      messageId: wake.payload.messageId,
      threadId: h.auth.threadId,
      userId: h.auth.userId,
      catId: h.auth.catId,
      expectedDeploymentWait: true,
    };
    assert.equal(await startGuard(h).canStart(identity), true, 'the real wake passes its final execution gate');
    assert.equal(await startGuard(h, false).canStart(identity), false, 'missing authority stores fail closed');
    h.handoffProposalStore.get = () => null;
    assert.equal(
      await startGuard(h).canStart(identity),
      false,
      'invalidation after publication still blocks execution',
    );
    assert.equal(h.getWakes(), 1);
  });
}

for (const grade of ['unknown', 'compatibility_fallback']) {
  test(`handoff wait preserves ${grade} and restricted tools across lifecycle reconstruction`, async (t) => {
    const policy = {
      mode: 'callback_allowlist',
      allowedCallbackRoutes: ['POST /api/callbacks/register-deployment-wait'],
    };
    const h = await handoffWaitFixture(t, {
      authorization: { ownerAuthProvenance: grade, toolExecutionPolicy: policy },
    });
    assert.equal((await h.register()).statusCode, 200);
    await h.finish();
    assert.equal((await h.ready()).kind, 'notified');
    const [wake] = h.connector.admitted(h.auth.threadId, h.auth.userId);
    assert.equal(wake.execution.ownerAuthProvenance, grade);
    assert.deepEqual(wake.execution.readOnlyToolPolicy, policy);
  });
}

test('ordinary private input cannot register even with a valid later user message', async (t) => {
  const h = await handoffWaitFixture(t, { privateInput: true });
  appendUserInput(h);
  const response = await h.register();
  assert.equal(response.statusCode, 409);
  assert.equal((await h.taskStore.get(h.task.id)).deploymentWait, undefined);
});

test('read-only handoff cannot acquire write authority to register a wait', async (t) => {
  const h = await handoffWaitFixture(t, {
    authorization: {
      ownerAuthProvenance: 'unknown',
      toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    },
  });
  assert.equal((await h.register()).statusCode, 403);
  assert.equal((await h.taskStore.get(h.task.id)).deploymentWait, undefined);
});

test('a handoff cannot replace a present but invalid message origin', async (t) => {
  const h = await handoffWaitFixture(t);
  h.auth.originTriggerMessageId = 'not-an-active-input';
  assert.equal((await h.register()).statusCode, 409);
  assert.equal(h.taskStore.getWaitRegistration(h.task.id).receipt, null);
});

for (const field of ['inputEntryIds', 'privateInputEntryIds']) {
  test(`handoff binding without its exact ${field} cannot register`, async (t) => {
    const h = await handoffWaitFixture(t);
    const get = h.invocationTracker.getActiveSlots.bind(h.invocationTracker);
    h.invocationTracker.getActiveSlots = (threadId) =>
      get(threadId).map((slot) => ({
        ...slot,
        activeRun: { ...slot.activeRun, [field]: [] },
      }));
    assert.equal((await h.register()).statusCode, 409);
    assert.equal(h.taskStore.getWaitRegistration(h.task.id).receipt, null);
  });
}

for (const [name, change] of [
  ['unapproved', (p) => ({ ...p, status: 'pending' })],
  ['expired', (p) => ({ ...p, status: 'expired' })],
  ['different continuation', (p) => ({ ...p, continuationEntryId: 'other-entry' })],
  ['different user', (p) => ({ ...p, userId: 'other-user' })],
  ['different cat', (p) => ({ ...p, sourceCatId: 'opus' })],
  ['different thread', (p) => ({ ...p, sourceThreadId: 'other-thread' })],
  ['different session', (p) => ({ ...p, sourceSessionId: 'other-session' })],
  ['missing', () => null],
]) {
  test(`handoff registration rejects ${name} approval without a Task write`, async (t) => {
    const h = await handoffWaitFixture(t);
    const get = h.handoffProposalStore.get.bind(h.handoffProposalStore);
    h.handoffProposalStore.get = (id) => change(get(id));
    const response = await h.register();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait, undefined);
    assert.equal(h.taskStore.getWaitRegistration(h.task.id).receipt, null);
  });
}

test('an invalidated approval cannot publish a previously registered handoff wait', async (t) => {
  const h = await handoffWaitFixture(t);
  assert.equal((await h.register()).statusCode, 200);
  await h.finish();
  h.handoffProposalStore.get = () => null;
  assert.equal((await h.ready()).kind, 'state_only');
  assert.equal(h.getWakes(), 0);
});

for (const reason of ['cancel', 'task_terminal']) {
  test(`handoff ${reason} cannot be revived by later ready`, async (t) => {
    const h = await handoffWaitFixture(t);
    assert.equal((await h.register()).statusCode, 200);
    await h.finish();
    if (reason === 'cancel') await h.lifecycle.cancel(h.task.id, { kind: 'user', userId: h.auth.userId });
    else {
      await h.taskStore.update(h.task.id, { status: 'done' });
      await h.lifecycle.taskCompleted(h.task.id);
    }
    await h.ready();
    assert.equal(h.getWakes(), 0);
  });
}

for (const [name, change] of [
  ['not sealed', (s) => ({ ...s, status: 'active' })],
  ['wrong seal reason', (s) => ({ ...s, sealReason: 'global_reaper' })],
  ['another handoff', (s) => ({ ...s, catHandoffNote: { ...s.catHandoffNote, proposalId: 'another-proposal' } })],
]) {
  test(`handoff registration rejects source session ${name}`, async (t) => {
    const h = await handoffWaitFixture(t);
    h.sessionChainStore.get = () => change(structuredClone(h.session));
    assert.equal((await h.register()).statusCode, 409);
    assert.equal(h.taskStore.getWaitRegistration(h.task.id).receipt, null);
  });
}
