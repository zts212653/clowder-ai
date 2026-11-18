import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossThreadFailureReturnInput } from '../dist/domains/cats/services/agents/invocation/cross-thread-failure-return.js';
import { lifecycleResponseIdempotencyKey } from '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { commitRecoveredFailedResponse } from '../dist/routes/callback-a2a-trigger.js';
import { crossThreadFailureStores } from './helpers/cross-thread-failure-fixture.mjs';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function build(t, kind, { localCaller, crossCaller, target = 'opus' }) {
  const f = await crossThreadFailureStores(t, kind);
  const localIn = await f.messages.append({
    from: { kind: 'agent', catId: localCaller },
    userId: 'owner',
    threadId: 'thread',
    content: `@${target} local`,
    mentions: [target],
    timestamp: 100,
    lifecycle: { kind: 'input', orderKey: '100' },
  });
  const crossIn = await f.messages.append({
    from: { kind: 'agent', catId: crossCaller },
    userId: 'owner',
    threadId: 'thread',
    content: `@${target} cross`,
    mentions: [target],
    timestamp: 101,
    extra: { crossPost: { sourceThreadId: 'origin', sourceInvocationId: 'origin-parent' } },
    lifecycle: { kind: 'input', orderKey: '101' },
  });
  const response = await f.messages.append({
    from: { kind: 'agent', catId: target },
    userId: 'owner',
    threadId: 'thread',
    content: '',
    mentions: [],
    timestamp: 110,
    replyTo: localIn.id,
    idempotencyKey: lifecycleResponseIdempotencyKey('child'),
    extra: {
      a2aFailureReturn: {
        triggerMessageId: localIn.id,
        callerCatId: localCaller,
        ownerAuthProvenance: 'strict',
        parentInvocationId: 'parent',
        isFailureReport: false,
      },
      coveredA2AFailureReturns: [
        {
          triggerMessageId: crossIn.id,
          callerCatId: crossCaller,
          ownerAuthProvenance: 'strict',
          isFailureReport: false,
        },
      ],
    },
    lifecycle: {
      kind: 'response',
      orderKey: '110',
      invocationId: 'child',
      targetId: target,
      inputEntryIds: ['e1', 'e2'],
      inputMessageIds: [localIn.id, crossIn.id],
      status: 'processing',
      startedAt: 110,
    },
  });
  for (const m of [localIn, crossIn]) {
    await f.messages.advanceLifecycleInputDispatch(m.id, {
      kind: 'input',
      orderKey: m.lifecycle.orderKey,
      targetId: target,
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: 110,
    });
  }
  const drains = [];
  const deps = {
    messageStore: f.messages,
    invocationQueue: f.queue,
    queueProcessor: { requestDrain: async (threadId) => drains.push(threadId) },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
    log: { info() {}, warn() {}, error() {} },
    routingDispatchPreflight: {
      preflight: async (request) => ({
        v: 1,
        ownerId: request.ownerId,
        observedAt: 120,
        resolverState: 'ready',
        targets: request.targetCatIds.map((targetCatId) => ({
          targetCatId,
          disposition: 'accepted',
          reasons: [],
          alternatives: [],
        })),
      }),
    },
  };
  const patch = (current) => ({
    invocationId: 'child',
    status: 'failed',
    completedAt: 120,
    reason: 'provider_error',
    content: '',
    mentions: [],
    extra: current.extra,
    replyTo: current.replyTo,
  });
  return { ...f, deps, localIn, crossIn, response, patch, drains };
}

for (const kind of ['memory', 'redis']) {
  const options = { skip: kind === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false };
  for (const [localCaller, crossCaller] of [
    ['codex', 'gemini'],
    ['codex', 'codex'],
    ['codex', 'opus'],
  ]) {
    test(
      `${kind}: one atomic response returns to local ${localCaller} and origin ${crossCaller}`,
      options,
      async (t) => {
        const f = await build(t, kind, { localCaller, crossCaller });
        const current = await f.messages.getById(f.response.id);
        await commitRecoveredFailedResponse(f.deps, current, f.patch(current));
        const done = await f.messages.getById(f.response.id);
        assert.equal(done.lifecycle.status, 'failed');
        assert.deepEqual(
          (await f.queue.listAllDurable('thread')).map((row) => row.targets),
          [[localCaller]],
        );
        assert.deepEqual(
          (await f.queue.listAllDurable('origin')).map((row) => row.targets),
          [[crossCaller]],
        );
        await commitRecoveredFailedResponse(f.deps, done, f.patch(done));
        assert.equal((await f.queue.listAllDurable('thread')).length, 1);
        assert.equal((await f.queue.listAllDurable('origin')).length, 1);
      },
    );
  }
  test(
    `${kind}: an origin receipt conflict cannot partially commit the response or its local wake`,
    options,
    async (t) => {
      const f = await build(t, kind, { localCaller: 'codex', crossCaller: 'gemini' });
      const current = await f.messages.getById(f.response.id);
      const returned = crossThreadFailureReturnInput(f.crossIn, current.id, ['opus'], 'strict');
      await f.queue.enqueueDurable({ ...returned, content: 'different envelope at the same identity' });
      f.drains.length = 0;
      await assert.rejects(commitRecoveredFailedResponse(f.deps, current, f.patch(current)), /admission conflict/);
      assert.equal((await f.messages.getById(current.id)).lifecycle.status, 'processing');
      assert.deepEqual(
        await f.queue.listAllDurable('thread'),
        [],
        'local admission is rolled back with the entire transaction',
      );
      assert.equal(
        (await f.queue.listAllDurable('origin')).length,
        1,
        'conflicting identity is preserved, never overwritten',
      );
      assert.deepEqual(f.drains, [], 'no terminal or local admission was published');
    },
  );
}
