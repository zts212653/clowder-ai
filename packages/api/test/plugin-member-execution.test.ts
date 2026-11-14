import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { memberExecutionKey } from '../src/domains/plugin/member-sessions/validation.js';
import { memberExecutionFixture as fixture } from './helpers/plugin-member-execution-fixture.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

test('an unresolved semantic input keeps one execution across retries and refuses a second wake', async () => {
  const f = await fixture();
  await assert.rejects(
    () => f.port.execute({ ...f.input, executionId: 'event-2', semanticCursor: 8 }),
    /execution_pending/,
  );
  assert.equal(f.sends(), 1);
  assert.equal((await f.port.execute(f.input)).messageId, f.queued.messageId);
});

test('canonical child and response completion advance the cursor once, including a Host recreation', async () => {
  const f = await fixture();
  const started = await f.host().claim(f.claim);
  assert.equal(started.phase, 'running');
  assert.equal((await f.port.get(f.session.sessionId))?.consumedCursor, 0);
  await f.host().assertCurrent(f.claim);
  assert.throws(
    () => f.turns.transitionTerminal(f.claim.invocationId, { status: 'succeeded', endedAt: 200 }),
    /provider_teardown_unconfirmed/,
  );
  await assert.rejects(() => f.host().settle(f.claim), /settlement_pending/);
  f.turns.recordProviderTeardown(f.claim.invocationId, 201);
  f.turns.transitionTerminal(f.claim.invocationId, { status: 'succeeded', endedAt: 201 });
  await assert.rejects(() => f.host().settle(f.claim), /settlement_pending/);
  f.messages.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.claim.invocationId,
    status: 'completed',
    completedAt: 202,
    content: '真实响应落盘',
    mentions: [],
  });
  const settled = await f.host().settle(f.claim);
  assert.equal(settled.phase, 'succeeded');
  assert.equal(settled.responseMessageId, f.response.id);
  assert.deepEqual(await f.host().settle(f.claim), settled);
  assert.equal((await f.service().forInstance(f.scope()).get(f.session.sessionId))?.consumedCursor, 7);
  assert.equal(f.sends(), 1);
  await assert.rejects(() => f.port.execute({ ...f.input, executionId: 'duplicate-cursor' }), /cursor/);
});

test('claiming does not let a source become another child, response, or coalesced hidden input', async () => {
  const f = await fixture();
  await assert.rejects(() => f.host().claim({ ...f.claim, invocationId: 'invented-child' }), /execution_evidence/);
  await assert.rejects(
    () => f.host().claim({ ...f.claim, responseMessageId: 'invented-response' }),
    /execution_evidence/,
  );
  const wrong = f.messages.append({
    userId: 'owner',
    threadId: 'game-thread',
    from: { kind: 'agent', catId: createCatId('member') },
    content: '',
    mentions: [],
    timestamp: 100,
    lifecycle: {
      kind: 'response',
      orderKey: '100:other',
      invocationId: f.claim.invocationId,
      targetId: 'member',
      inputEntryIds: ['another-entry'],
      inputMessageIds: [f.queued.messageId, 'hidden-source'],
      status: 'processing',
      startedAt: 100,
    },
  });
  await assert.rejects(() => f.host().claim({ ...f.claim, responseMessageId: wrong.id }), /execution_evidence/);
  await f.host().claim(f.claim);
  await assert.rejects(
    () => f.host().claim({ ...f.claim, invocationId: 'replacement-child' }),
    /execution_evidence|execution_claim_conflict/,
  );
  assert.equal(f.sends(), 1);
});

test('account change, revocation and regrant fence every old invocation check', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  f.changeAccount();
  await assert.rejects(() => f.host().assertCurrent(f.claim), /runtime_changed/);
  const other = await fixture();
  await other.host().claim(other.claim);
  await other.owner(() => other.port.revoke(other.session.sessionId));
  await assert.rejects(() => other.host().assertCurrent(other.claim), /revoked/);
  await other.owner(() => other.port.prepare(other.prepareInput), 'owner-regrant');
  await assert.rejects(() => other.host().assertCurrent(other.claim), /generation_changed/);
});

for (const status of ['failed', 'canceled', 'interrupted'] as const) {
  test(`canonical ${status} preserves the cursor and never re-admits the execution`, async () => {
    const f = await fixture();
    await f.host().claim(f.claim);
    f.turns.transitionTerminal(f.claim.invocationId, {
      status,
      endedAt: 200,
      terminalReason: 'process_restart',
      providerTeardownAt: 200,
    });
    f.messages.commitLifecycleResponseTerminal(f.response.id, {
      invocationId: f.claim.invocationId,
      status,
      completedAt: 200,
      reason: 'process_restart',
      content: '',
      mentions: [],
    });
    assert.equal((await f.host().settle(f.claim)).phase, status);
    assert.equal((await f.port.get(f.session.sessionId))?.consumedCursor, 0);
    assert.equal((await f.port.execute(f.input)).phase, status);
    assert.equal(f.sends(), 1);
    await assert.rejects(() => f.host().assertCurrent(f.claim), /execution_not_found|execution_not_running/);
  });
}

test('revocation stops tools but still records the original canonical canceled result after teardown', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  await f.owner(() => f.port.revoke(f.session.sessionId));
  f.turns.transitionTerminal(f.claim.invocationId, {
    status: 'canceled',
    endedAt: 200,
    terminalReason: 'user_stop',
  });
  assert.equal(f.turns.get(f.claim.invocationId)?.status, 'canceled');
  assert.equal(f.turns.get(f.claim.invocationId)?.providerTeardownAt, undefined);
  f.messages.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.claim.invocationId,
    status: 'canceled',
    completedAt: 200,
    reason: 'user_stop',
    content: '',
    mentions: [],
  });
  await assert.rejects(() => f.host().settle(f.claim), /settlement_pending/);
  f.turns.recordProviderTeardown(f.claim.invocationId, 201);
  f.changeAccount();
  f.revokeInstallation();
  const stopped = f.service().hostExecutionsForInstance({
    ...f.scope(),
    assertCurrent: async () => {
      throw new Error('activation_stopped');
    },
  });
  const original = await stopped.settle(f.claim);
  assert.equal(original.phase, 'canceled');
  assert.equal(original.messageId, f.queued.messageId);
  assert.deepEqual(await f.host().settle(f.claim), original);
  await assert.rejects(() => f.host().assertCurrent(f.claim), /revoked/);
  const row = await f.deps.storage.get('grants', f.session.sessionId);
  assert.equal((row?.value as { consumedCursor: number }).consumedCursor, 0);
  assert.equal(f.sends(), 1);
});

test('revocation during an asynchronous canonical evidence read also fences the old callback', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  const host = createPluginMemberSessions({
    ...f.deps,
    canonicalExecution: {
      turns: f.turns,
      messages: {
        getById: async (id) => {
          await f.owner(() => f.port.revoke(f.session.sessionId));
          return f.messages.getById(id);
        },
      },
    },
  }).hostExecutionsForInstance(f.scope());
  await assert.rejects(() => host.assertCurrent(f.claim), /revoked/);
  assert.equal(f.sends(), 1);
});

for (const phase of ['running', 'succeeded'] as const) {
  test(`a child may be ${phase} before the admission ACK without being downgraded or awakened again`, async () => {
    const f = memberSessionFixture();
    const turns = new InMemoryTurnExecutionStore(),
      messages = new MessageStore();
    const service = () => createPluginMemberSessions({ ...f.deps, canonicalExecution: { turns, messages } });
    const port = service().forInstance(f.scope());
    const session = await f.owner(() => port.prepare(f.prepareInput));
    const input = {
      sessionId: session.sessionId,
      generation: session.generation,
      executionId: 'early-event',
      semanticCursor: 9,
      content: '消息已准入而发送ACK未返回',
    };
    f.afterSend(async () => {
      const original = await f.deps.messaging.findSent({
        idempotencyKey: memberExecutionKey(input),
      });
      assert.ok(original);
      const messageId = original.messageId;
      turns.createRunning({
        invocationId: 'early-child',
        parentInvocationId: 'queue-parent',
        userId: 'owner',
        threadId: 'game-thread',
        catId: createCatId('member'),
        executionKind: 'ordinary',
        providerLifecycleTracked: true,
        causal: { triggerMessageId: messageId },
        startedAt: 100,
      });
      const response = messages.append({
        userId: 'owner',
        threadId: 'game-thread',
        from: { kind: 'agent', catId: createCatId('member') },
        content: '',
        mentions: [],
        timestamp: 100,
        lifecycle: {
          kind: 'response',
          orderKey: '100:early-child',
          invocationId: 'early-child',
          targetId: 'member',
          inputEntryIds: ['queue-entry'],
          inputMessageIds: [messageId],
          status: 'processing',
          startedAt: 100,
        },
      });
      const claim = {
        sessionId: session.sessionId,
        generation: session.generation,
        executionId: input.executionId,
        invocationId: 'early-child',
        responseMessageId: response.id,
      };
      await service().hostExecutionsForInstance(f.scope()).claim(claim);
      if (phase === 'succeeded') {
        turns.markProviderStarted('early-child', 101);
        turns.transitionTerminal('early-child', { status: 'succeeded', endedAt: 102, providerTeardownAt: 102 });
        messages.commitLifecycleResponseTerminal(response.id, {
          invocationId: 'early-child',
          status: 'completed',
          completedAt: 102,
          content: 'fixture done',
          mentions: [],
        });
        await service().hostExecutionsForInstance(f.scope()).settle(claim);
      }
    });
    assert.equal((await port.execute(input)).phase, phase);
    assert.equal((await service().forInstance(f.scope()).execute(input)).phase, phase);
    assert.equal(f.sends(), 1);
  });
}

test('terminal settlement keeps the exact owner, package, instance and generation boundary after revocation', async () => {
  const f = await fixture();
  await f.host().claim(f.claim);
  await f.owner(() => f.port.revoke(f.session.sessionId));
  f.turns.transitionTerminal(f.claim.invocationId, {
    status: 'canceled',
    endedAt: 200,
    providerTeardownAt: 200,
    terminalReason: 'user_stop',
  });
  f.messages.commitLifecycleResponseTerminal(f.response.id, {
    invocationId: f.claim.invocationId,
    status: 'canceled',
    completedAt: 200,
    content: '',
    mentions: [],
  });
  for (const changed of [
    { ownerUserId: 'foreign-owner' },
    { packageDigest: 'foreign-package' },
    { pluginInstanceId: 'foreign-instance' },
  ]) {
    const host = f.service().hostExecutionsForInstance({ ...f.scope(), ...changed });
    await assert.rejects(() => host.settle(f.claim), /scope_mismatch/);
  }
  await assert.rejects(() => f.host().settle({ ...f.claim, generation: 2 }), /generation_changed/);
  assert.equal((await f.host().settle(f.claim)).phase, 'canceled');
  assert.equal(f.sends(), 1);
});
