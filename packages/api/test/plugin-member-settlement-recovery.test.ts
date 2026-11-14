import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { pluginSentMessageStorageKey } from '../src/domains/plugin/host-surface/plugin-sent-message-read.js';
import { createMemberSessionHost } from '../src/domains/plugin/member-sessions/host.js';
import { memberExecutionKey } from '../src/domains/plugin/member-sessions/validation.js';
import { memberExecutionFixture as fixture } from './helpers/plugin-member-execution-fixture.js';

function cancelProvider(f: Awaited<ReturnType<typeof fixture>>, teardown = true) {
  if (teardown) f.turns.recordProviderTeardown(f.claim.invocationId, 200);
  const terminal = { status: 'canceled' as const, endedAt: 200, terminalReason: 'user_stop' };
  f.turns.transitionTerminal(f.claim.invocationId, terminal);
  f.messages.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.claim.invocationId,
    status: 'canceled',
    completedAt: 202,
    content: '',
    mentions: [],
  });
}

test('late original teardown settles its archived generation without changing a renewed grant or waking again', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  await f.owner(() => f.port.revoke(f.session.sessionId));
  const renewed = await f.owner(() => f.port.prepare(f.prepareInput), 'renew-before-provider-teardown');
  cancelProvider(f);
  const receipt = await f.host().settle(f.claim);
  assert.equal(receipt.phase, 'canceled');
  assert.equal(receipt.invocationId, f.claim.invocationId);
  const current = await f.port.get(f.session.sessionId);
  assert.equal(current?.generation, renewed.generation);
  assert.equal(current?.consumedCursor, 0);
  await assert.rejects(f.host().assertCurrent(f.claim), /generation_changed/);
  assert.equal(f.sends(), 1);
});

test('a recreated Host reads canonical terminal evidence when the original finalizer was lost, without a write or cursor advance', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  await f.owner(() => f.port.revoke(f.session.sessionId));
  await f.owner(() => f.port.prepare(f.prepareInput), 'renew-before-host-recovery');
  cancelProvider(f);
  let writes = 0;
  const original = f.deps.storage.compareAndSet.bind(f.deps.storage);
  f.deps.storage.compareAndSet = async (...args) => {
    writes++;
    return original(...args);
  };
  const receipt = await f.service().forInstance(f.scope()).getExecution({
    sessionId: f.input.sessionId,
    generation: f.input.generation,
    executionId: f.input.executionId,
  });
  assert.equal(receipt?.phase, 'canceled');
  assert.equal(receipt?.responseMessageId, f.response.id);
  assert.equal(writes, 0);
  assert.equal((await f.port.get(f.session.sessionId))?.consumedCursor, 0);
  assert.equal(f.sends(), 1);
});

for (const status of ['failed', 'canceled', 'interrupted'] as const) {
  test(`a logical ${status} still needs physical teardown for a terminal member receipt`, async () => {
    const f = await fixture();
    await f.host().claim(f.claim);
    f.turns.transitionTerminal(f.claim.invocationId, { status, endedAt: 200, terminalReason: 'process_restart' });
    f.messages.commitLifecycleResponseTerminal(f.response.id, {
      invocationId: f.claim.invocationId,
      status,
      completedAt: 202,
      content: '',
      mentions: [],
    });
    const lookup = {
      sessionId: f.session.sessionId,
      generation: f.session.generation,
      executionId: f.input.executionId,
    };
    assert.equal(f.turns.get(f.claim.invocationId)?.status, status);
    assert.equal(f.turns.get(f.claim.invocationId)?.providerTeardownAt, undefined);
    assert.equal((await f.service().forInstance(f.scope()).getExecution(lookup))?.phase, 'running');
    await assert.rejects(f.host().settle(f.claim), /settlement_pending/);
    assert.equal((await f.port.get(f.session.sessionId))?.consumedCursor, 0);
    assert.equal(f.sends(), 1);

    f.turns.recordProviderTeardown(f.claim.invocationId, 201);
    const recovered = await f.service().forInstance(f.scope()).getExecution(lookup);
    assert.equal(recovered?.phase, status);
    assert.equal(recovered?.invocationId, f.claim.invocationId);
    assert.equal((await f.port.get(f.session.sessionId))?.consumedCursor, 0);
    assert.equal(f.sends(), 1);
  });
}

test('read-only recovery finds an unstarted canceled child through the original canonical source and response index', async () => {
  const f = await fixture({ providerStarted: false });
  await f.owner(() => f.port.revoke(f.session.sessionId));
  await f.owner(() => f.port.prepare(f.prepareInput), 'renew-unclaimed-child');
  cancelProvider(f, false);
  const receipt = await f.port.getExecution({
    sessionId: f.input.sessionId,
    generation: f.input.generation,
    executionId: f.input.executionId,
  });
  assert.equal(receipt?.phase, 'canceled');
  assert.equal(receipt?.invocationId, f.claim.invocationId);
  assert.equal(receipt?.responseMessageId, f.response.id);
  assert.equal(f.sends(), 1);
});

test('an unclaimed provider-started child still cannot become a terminal member receipt through read-only recovery', async () => {
  const f = await fixture();
  cancelProvider(f);
  await assert.rejects(
    f.port.getExecution({
      sessionId: f.input.sessionId,
      generation: f.input.generation,
      executionId: f.input.executionId,
    }),
    /unclaimed_provider_started/,
  );
});

test('source ambiguity keeps the original execution unresolved rather than selecting a later child', async () => {
  const f = await fixture({ providerStarted: false });
  cancelProvider(f, false);
  f.turns.createRunning({
    invocationId: 'other-child',
    parentInvocationId: 'other-parent',
    userId: 'owner',
    threadId: 'game-thread',
    catId: createCatId('member'),
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    startedAt: 100,
    causal: { triggerMessageId: f.queued.messageId, coveredMessageIds: [f.queued.messageId] },
  });
  await assert.rejects(
    f.port.getExecution({
      sessionId: f.input.sessionId,
      generation: f.input.generation,
      executionId: f.input.executionId,
    }),
    /ambiguous_source/,
  );
  assert.equal(f.sends(), 1);
});

test('a late successful old child preserves the renewed generation cursor and cannot authorize another old tool', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  await f.owner(() => f.port.revoke(f.session.sessionId));
  const renewed = await f.owner(() => f.port.prepare(f.prepareInput), 'renew-before-late-success');
  f.turns.recordProviderTeardown(f.claim.invocationId, 201);
  f.turns.transitionTerminal(f.claim.invocationId, { status: 'succeeded', endedAt: 200 });
  f.messages.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.claim.invocationId,
    status: 'completed',
    completedAt: 202,
    content: 'actual old result',
    mentions: [],
  });
  assert.equal((await f.host().settle(f.claim)).phase, 'succeeded');
  const current = await f.port.get(f.session.sessionId);
  assert.equal(current?.generation, renewed.generation);
  assert.equal(current?.consumedCursor, 0);
  await assert.rejects(f.host().assertCurrent(f.claim), /generation_changed/);
  assert.equal(f.sends(), 1);
});

test('the next authorized input reconciles a lost original finalizer before creating its own single child', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  cancelProvider(f);
  const next = await f.port.execute({
    ...f.input,
    executionId: 'next-event',
    semanticCursor: 8,
    content: 'next own event',
  });
  assert.equal(next.phase, 'queued');
  assert.equal(f.sends(), 2);
  assert.equal(
    (
      await f.port.getExecution({
        sessionId: f.input.sessionId,
        generation: f.input.generation,
        executionId: f.input.executionId,
      })
    )?.phase,
    'canceled',
  );
  assert.equal((await f.port.get(f.session.sessionId))?.consumedCursor, 0);
});

test('the actual module facade reconciles the original terminal child before its pending-input precheck', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  cancelProvider(f);
  const module = createMemberSessionHost(f.service()).forInstance(f.scope());
  const next = await module.execute({
    ...f.input,
    executionId: 'next-via-module',
    semanticCursor: 8,
    content: 'next visible event',
  });
  assert.equal(next.phase, 'queued');
  assert.equal(f.sends(), 2);
});

test('read-only execution lookup recovers the original receipt after revoke and Host recreation without another wake', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  await f.owner(() => f.port.revoke(f.session.sessionId));
  f.turns.recordProviderTeardown(f.claim.invocationId, 201);
  f.turns.transitionTerminal(f.claim.invocationId, { status: 'canceled', endedAt: 200, terminalReason: 'user_stop' });
  f.messages.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.claim.invocationId,
    status: 'canceled',
    completedAt: 202,
    content: '',
    mentions: [],
  });
  const original = await f.host().settle(f.claim);
  const lookup = { sessionId: f.session.sessionId, generation: f.session.generation, executionId: f.input.executionId };
  assert.deepEqual(await f.service().forInstance(f.scope()).getExecution(lookup), original);
  const renewed = await f.owner(() => f.port.prepare(f.prepareInput), 'owner-resource-renewal');
  assert.equal(renewed.generation, lookup.generation + 1);
  assert.deepEqual(await f.service().forInstance(f.scope()).getExecution(lookup), original);
  await assert.rejects(f.port.getExecution({ ...lookup, generation: renewed.generation + 1 }), /generation_changed/);
  assert.equal(f.sends(), 1);
});

test('an unclaimed provider-started child cannot acquire a member binding through settlement', async () => {
  const f = await fixture();
  f.turns.recordProviderTeardown(f.claim.invocationId, 201);
  f.turns.transitionTerminal(f.claim.invocationId, { status: 'canceled', endedAt: 200, terminalReason: 'user_stop' });
  f.messages.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.claim.invocationId,
    status: 'canceled',
    completedAt: 202,
    content: '',
    mentions: [],
  });
  await assert.rejects(f.host().settle(f.claim), /unclaimed_provider_started/);
  assert.equal((await f.port.get(f.session.sessionId))?.consumedCursor, 0);
});

test('an unstarted child stopped before sender ACK resolves its original canonical message index without a new send', async () => {
  const f = await fixture();
  const source = f.messages.append({
    userId: 'owner',
    threadId: 'game-thread',
    from: { kind: 'plugin', instanceId: 'installed' },
    content: f.input.content,
    mentions: [],
    timestamp: 300,
    idempotencyKey: pluginSentMessageStorageKey('installed', memberExecutionKey(f.input)),
    extra: {
      pluginMessage: {
        instanceId: 'installed',
        revision: 1,
        provenance: { epistemicStatus: 'observation' },
        elements: [],
      },
    },
  });
  const saved = await f.deps.storage.get('grants', f.session.sessionId);
  assert.ok(saved);
  const row = saved.value as { executions: Record<string, { phase: string; messageId?: string }> };
  row.executions[f.input.executionId] = {
    ...row.executions[f.input.executionId],
    phase: 'admitting',
    messageId: undefined,
  };
  await f.deps.storage.compareAndSet('grants', f.session.sessionId, saved.revision, row);
  const invocationId = 'unstarted-child';
  f.turns.createRunning({
    invocationId,
    parentInvocationId: 'queue-parent',
    userId: 'owner',
    threadId: 'game-thread',
    catId: createCatId('member'),
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    causal: { triggerMessageId: source.id, coveredMessageIds: [source.id] },
    startedAt: 300,
  });
  const response = f.messages.append({
    userId: 'owner',
    threadId: 'game-thread',
    from: { kind: 'agent', catId: createCatId('member') },
    content: '',
    mentions: [],
    timestamp: 300,
    lifecycle: {
      kind: 'response',
      orderKey: '300:unstarted-child',
      invocationId,
      targetId: 'member',
      inputEntryIds: ['entry'],
      inputMessageIds: [source.id],
      status: 'processing',
      startedAt: 300,
    },
  });
  f.turns.transitionTerminal(invocationId, { status: 'canceled', endedAt: 301, terminalReason: 'user_stop' });
  f.messages.commitLifecycleResponseTerminal(response.id, {
    invocationId,
    status: 'canceled',
    completedAt: 301,
    content: '',
    mentions: [],
  });
  f.revokeInstallation();
  const receipt = await f.host().settle({ ...f.claim, invocationId, responseMessageId: response.id });
  assert.equal(receipt.phase, 'canceled');
  assert.equal(receipt.messageId, source.id);
  assert.equal(receipt.invocationId, invocationId);
  assert.equal(f.sends(), 1);
});
