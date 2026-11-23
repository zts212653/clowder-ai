import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallerDispatchObservationRegistry } from '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { commitRecoveredFailedResponse } from '../dist/routes/callback-a2a-trigger.js';
import { crossThreadFailureStores, crossThreadResponseFixture } from './helpers/cross-thread-failure-fixture.mjs';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

for (const kind of ['memory', 'redis']) {
  const options = { skip: kind === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false };

  for (const sameCat of [false, true]) {
    test(`${kind}: failed cross-post wakes its origin caller only (same cat: ${sameCat})`, options, async (t) => {
      const f = await crossThreadResponseFixture(t, kind, { sameCat });
      await f.recovery().reconcile({ processStartedAt: 200 });
      assert.deepEqual(f.turns.listResponsePending(), []);
      assert.equal((await f.messages.getById(f.response.id)).lifecycle.status, 'failed');
      assert.deepEqual(await f.queue.listAllDurable('thread'), [], 'no same-name caller wake in destination');
      const [wake] = await f.queue.listAllDurable('origin');
      assert.ok(wake, 'origin caller has a durable failure notification');
      assert.deepEqual(wake.targets, [sameCat ? 'opus' : 'codex']);
      assert.equal(wake.sourceCategory, 'a2a_failure');
      assert.match(wake.payload.content, new RegExp(f.response.id));
      assert.match(wake.payload.content, new RegExp(f.input.id));
      assert.match(wake.payload.content, /thread/);
      assert.deepEqual(f.preflightCalls, [], 'failure returns preserve the admitted caller, without rerouting');

      const restored = new InvocationQueue(f.ledger);
      await restored.hydrateFromLedger(f.messages);
      assert.deepEqual(
        restored.list('origin', 'owner').map((entry) => entry.id),
        [wake.id],
      );
      const response = await f.messages.getById(f.response.id);
      const patch = {
        invocationId: 'child',
        status: 'failed',
        completedAt: response.lifecycle.completedAt,
        reason: response.lifecycle.reason,
        content: response.content,
        mentions: response.mentions,
        extra: response.extra,
        replyTo: response.replyTo,
      };
      await commitRecoveredFailedResponse({ ...f.deps, invocationQueue: restored }, response, patch);
      assert.equal((await restored.listAllDurable('origin')).length, 1, 'retry cannot duplicate a return');
      assert.ok(
        await restored.markProcessingDurable('origin', 'owner', { entryId: wake.id, targetCats: wake.targets }),
      );
      assert.ok(
        await restored.commitClaimedAdoptionDurable('origin', 'owner', wake.id, wake.targets[0], 'caller-turn', 300),
      );
      await commitRecoveredFailedResponse({ ...f.deps, invocationQueue: restored }, response, patch);
      assert.deepEqual(await restored.listAllDurable('origin'), [], 'a consumed notification must not be resurrected');
    });
  }

  test(
    `${kind}: source return admission failure keeps the result processing until atomic recovery`,
    options,
    async (t) => {
      const f = await crossThreadResponseFixture(t, kind);
      const commit = f.messages.commitLifecycleResponseTerminalWithQueueLedgerAdmission.bind(f.messages);
      f.messages.commitLifecycleResponseTerminalWithQueueLedgerAdmission = async () => {
        throw new Error('origin ledger temporarily unavailable');
      };
      await f.recovery().reconcile({ processStartedAt: 200 });
      assert.equal(f.turns.listResponsePending().length, 1, 'return obligation survives a failed admission');
      assert.equal((await f.messages.getById(f.response.id)).lifecycle.status, 'processing');
      assert.deepEqual(await f.queue.listAllDurable('thread'), []);
      f.messages.commitLifecycleResponseTerminalWithQueueLedgerAdmission = commit;
      await f.recovery().reconcile({ processStartedAt: 200 });
      assert.equal(f.turns.listResponsePending().length, 0);
      assert.equal((await f.queue.listAllDurable('origin')).length, 1);
    },
  );

  test(`${kind}: prestart rejection returns atomically to the cross-post origin`, options, async (t) => {
    const f = await crossThreadFailureStores(t, kind);
    const admitted = await f.queue.send(
      f.messages,
      {
        from: { kind: 'agent', catId: 'codex' },
        userId: 'owner',
        threadId: 'thread',
        content: '@opus work',
        mentions: ['opus'],
        timestamp: 100,
        extra: { crossPost: { sourceThreadId: 'origin' } },
      },
      {
        from: { kind: 'agent', catId: 'codex' },
        userId: 'owner',
        threadId: 'thread',
        kind: 'message_wake',
        sourceCategory: 'a2a',
        content: '@opus work',
        targetCats: ['opus'],
        ownerAuthProvenance: 'strict',
        intent: 'execute',
        autoExecute: true,
      },
    );
    const claim = await f.queue.claimPreAdmissionFailureAcrossUsersDurable('thread', admitted.entry.id, ['opus']);
    assert.ok(claim);
    const failure = await f.queue.terminalizeClaimedAdmissionFailure(
      f.messages,
      admitted.message,
      claim,
      'opus',
      'invalid_explicit_target',
    );
    assert.equal(failure.kind, 'applied');
    assert.equal(
      (await f.queue.listAllDurable('thread')).filter((row) => row.sourceCategory === 'a2a_failure').length,
      0,
    );
    const [wake] = await f.queue.listAllDurable('origin');
    assert.ok(wake, 'prestart failure must also reach the actual caller');
    assert.deepEqual(wake.targets, ['codex']);
    assert.match(wake.payload.content, new RegExp(failure.failureMessage.id));
    assert.ok(f.drains.includes('origin'), 'origin thread gets an ordinary Queue drain signal');
    const retryDrains = [];
    const retrying = new InvocationQueue(f.ledger, { onAdmitted: ({ threadId }) => retryDrains.push(threadId) });
    await retrying.reprojectFailureWakes(failure.inputMessage, ['opus']);
    assert.equal(retrying.list('origin', 'owner').length, 1, 'lost-ack retry restores the actual origin carrier');
    assert.deepEqual(retryDrains, ['origin']);
    const restored = new InvocationQueue(f.ledger);
    await restored.hydrateFromLedger(f.messages);
    assert.equal(restored.list('origin', 'owner').length, 1);
  });
}

test('cross-post dispatch status is never attributed to the same-name cat in the delivery thread', async () => {
  const registry = new CallerDispatchObservationRegistry();
  const source = {
    id: 'cross-source',
    userId: 'owner',
    threadId: 'destination',
    from: { kind: 'agent', catId: 'codex' },
    content: 'work',
    timestamp: 100,
    extra: { crossPost: { sourceThreadId: 'origin' } },
    lifecycle: { kind: 'input', orderKey: '100', dispatchRefs: [] },
  };
  registry.registerInitialSource(source, ['opus']);
  registry.registerPersistedSource(source);
  registry.registerSteerChanges(source, { addedTargetIds: ['gemini'], removedTargetIds: [] });
  // Queue cancellation/Steer may supply identity-only pointers; projection must recheck History.
  registry.registerQueueWithdrawalByIdentity({
    ownerId: 'owner',
    threadId: 'destination',
    callerCatId: 'codex',
    sourceMessageId: source.id,
    targetIds: ['opus'],
  });
  const projection = await registry.project(
    { getById: async () => source },
    {
      ownerId: 'owner',
      threadId: 'destination',
      callerCatId: 'codex',
    },
  );
  assert.equal(projection.prompt, '');
});
