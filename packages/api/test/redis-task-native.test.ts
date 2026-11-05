import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import Redis from 'ioredis';
import { ordinaryTaskExpectation } from '../src/domains/cats/services/stores/ports/OrdinaryTaskMutation.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../src/domains/cats/services/stores/redis/RedisTaskStore.js';
import { RedisTurnExecutionStore } from '../src/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { RedisPawFeelDispositionEventLog } from '../src/infrastructure/harness-eval/paw-feel-disposition/event-log.js';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from './helpers/redis-test-helpers.js';
import { taskNativeCallbackFixture } from './helpers/task-native-callback-fixture.js';

async function fixture(t: TestContext) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'ordinary Task native CAS');
  const redis = new Redis(process.env.REDIS_URL!, { keyPrefix: `task-native-${randomUUID()}:` });
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  const store = new RedisTaskStore(redis);
  const task = await store.create({
    threadId: 'home',
    title: 'Original work',
    why: 'WIP retained',
    ownerCatId: 'codex',
    createdBy: 'codex',
    userId: 'task-user',
    sourceMessageId: 'accepted',
  });
  return { redis, store, task };
}

test('real Redis one-winner assignment and exact-source replay survive store reconstruction', async (t) => {
  const f = await fixture(t);
  const request = {
    kind: 'handoff' as const,
    taskId: f.task.id,
    expected: ordinaryTaskExpectation(f.task),
    ownerCatId: 'sonnet' as const,
    messageRef: 'message:one',
  };
  const results = await Promise.all([
    f.store.mutateOrdinaryTask(request),
    new RedisTaskStore(f.redis).mutateOrdinaryTask({ ...request, ownerCatId: 'codex-sol', messageRef: 'message:two' }),
  ]);
  assert.equal(results.filter((r) => r.kind === 'updated').length, 1);
  const winner = results.find((r) => r.kind === 'updated');
  assert.ok(winner && 'task' in winner);
  const retry =
    winner.task.ownerCatId === 'sonnet'
      ? request
      : { ...request, ownerCatId: 'codex-sol' as const, messageRef: 'message:two' };
  assert.equal((await new RedisTaskStore(f.redis).mutateOrdinaryTask(retry)).kind, 'replayed');
  const loaded = await new RedisTaskStore(f.redis).get(f.task.id);
  assert.equal(loaded?.ownerRevision, 1);
  assert.equal(loaded?.sourceMessageId, 'accepted');
  assert.equal(loaded?.threadId, 'home');
  assert.equal(loaded?.why, 'WIP retained');
});

test('real WATCH boundary rejects an old authenticated callback when assignment changes during authorization', async (t) => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const callback = f.store.mutateOrdinaryTask(
    {
      kind: 'update',
      taskId: f.task.id,
      expected: ordinaryTaskExpectation(f.task),
      actor: { userId: 'task-user', catId: 'codex', threadId: 'home', invocationId: 'old-callback' },
      input: { status: 'done' },
    },
    {
      async assertCurrent() {
        entered();
        await resume;
      },
    },
  );
  await barrier;
  await new RedisTaskStore(f.redis).update(f.task.id, { ownerCatId: 'sonnet' });
  release();
  assert.equal((await callback).kind, 'refused');
  assert.equal((await f.store.get(f.task.id))?.status, 'todo');
  assert.equal((await f.store.get(f.task.id))?.ownerCatId, 'sonnet');
});

test('Redis hydrates exact immutable handoff and provider teardown; malformed source cannot become ordinary speech', async (t) => {
  const f = await fixture(t);
  const messages = new RedisMessageStore(f.redis),
    turns = new RedisTurnExecutionStore(f.redis);
  const request = {
    v: 1 as const,
    taskId: f.task.id,
    expected: ordinaryTaskExpectation(f.task),
    issuer: { userId: 'task-user', catId: 'codex', threadId: 'home', invocationId: 'issuer' },
    targetCatId: 'sonnet',
    targetThreadId: 'home',
    ownerCatId: 'sonnet',
    stopPrevious: false,
  };
  const source = await messages.append({
    from: { kind: 'agent', catId: 'codex' },
    userId: 'task-user',
    threadId: 'home',
    content: 'Continue original Task',
    mentions: ['sonnet'],
    timestamp: Date.now(),
    origin: 'callback',
    extra: { taskHandoff: request },
  });
  assert.deepEqual((await new RedisMessageStore(f.redis).getById(source.id))?.extra?.taskHandoff, request);
  await f.redis.hset(`msg:${source.id}`, 'extra', JSON.stringify({ taskHandoff: { ...request, expected: undefined } }));
  const invalid = await new RedisMessageStore(f.redis).getById(source.id);
  assert.equal(invalid?.extra?.taskHandoff, undefined);
  assert.equal(invalid?.extra?.taskHandoffInvalid, true);
  await turns.createRunning({
    invocationId: 'exact-child',
    parentInvocationId: 'parent',
    userId: 'task-user',
    threadId: 'home',
    catId: 'sonnet',
    executionKind: 'ordinary',
    startedAt: 1,
  });
  await turns.transitionTerminal('exact-child', { status: 'succeeded', endedAt: 3, providerTeardownAt: 2 });
  assert.equal((await new RedisTurnExecutionStore(f.redis).get('exact-child'))?.providerTeardownAt, 2);
});

test('real callback and durable Queue reconstruct one source across restart and same-request retry without a second approval', async (t) => {
  const backend = await fixture(t);
  const first = await taskNativeCallbackFixture(t, backend.redis);
  const payload = {
    threadId: first.child.id,
    effectClass: 'assign_work',
    action: undefined,
    proposedAction: first.action,
  };
  const admitted = await first.send(payload);
  assert.equal(admitted.statusCode, 200, admitted.body);
  const id = admitted.json().messageId;
  const second = await taskNativeCallbackFixture(t, backend.redis, {
    homeId: first.home.id,
    childId: first.child.id,
    taskId: first.task.id,
  });
  await second.queue.hydrateFromLedger(second.messages);
  const replay = await second.send(payload);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().messageId, id);
  assert.equal(second.queue.list(first.child.id, 'native-user').length, 1);
  const task = await second.tasks.get(first.task.id);
  assert.equal(task?.lastAppliedHandoffMessageRef, `message:${id}`);
  assert.equal(task?.threadId, first.home.id);
  assert.deepEqual(first.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
  assert.deepEqual(second.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});

test('parented provider callback persists a valid handoff while its exact writer is still bound', async (t) => {
  // Alpha exposed the missing shape: real callbacks carry both parent and child identities.
  const backend = await fixture(t);
  const f = await taskNativeCallbackFixture(t, backend.redis);
  const parentInvocationId = 'real-provider-parent';
  const auth = await f.registry.create('native-user', 'codex', f.home.id, parentInvocationId);
  const execution = {
    invocationId: auth.invocationId,
    parentInvocationId,
    catId: 'codex' as const,
    threadId: f.home.id,
    sourceMessageId: null,
  };
  await f.turns.createRunning({
    ...execution,
    userId: 'native-user',
    executionKind: 'ordinary',
    startedAt: Date.now(),
    providerLifecycleTracked: true,
  });
  await f.turns.markProviderStarted(auth.invocationId, Date.now());
  const bound = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/update-task',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload: { taskId: f.task.id, status: 'doing' },
  });
  assert.equal(bound.statusCode, 200, bound.body);
  const payload = {
    content: 'Continue after this exact provider has torn down',
    targetCats: ['sonnet'],
    clientMessageId: 'parented-provider-handoff',
    action: f.action,
  };
  const send = () =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload,
    });
  const admitted = await send();
  assert.equal(admitted.statusCode, 200, admitted.body);
  const id = admitted.json().messageId;
  const source = await new RedisMessageStore(backend.redis).getById(id);
  assert.equal(source?.extra?.taskHandoffInvalid, undefined);
  assert.deepEqual(source?.extra?.taskHandoff?.issuer, {
    userId: 'native-user',
    catId: 'codex',
    threadId: f.home.id,
    invocationId: auth.invocationId,
  });
  assert.deepEqual((await f.tasks.get(f.task.id))?.executionRef, execution);
  assert.equal((await f.handoffs.apply(id)).kind, 'waiting');
  assert.equal((await send()).json().messageId, id);
  assert.equal(f.queue.list(f.home.id, 'native-user').length, 1);
  await f.turns.transitionTerminal(auth.invocationId, {
    status: 'succeeded',
    endedAt: Date.now(),
    providerTeardownAt: Date.now(),
  });
  assert.equal((await f.handoffs.apply(id)).kind, 'applied');
  assert.equal((await f.tasks.get(f.task.id))?.ownerCatId, 'sonnet');
  assert.equal((await f.tasks.get(f.task.id))?.lastAppliedHandoffMessageRef, `message:${id}`);
  assert.deepEqual(f.counts(), { proposalCreates: 0, cards: 0, leaseCalls: 0 });
});

test('F278 event append atomically refuses an assignment changed after authority resolution', async (t) => {
  const f = await fixture(t);
  const events = new RedisPawFeelDispositionEventLog(f.redis);
  const base = {
    actor: { kind: 'cat' as const, id: 'codex' },
    signalId: 'native-signal',
    occurredAt: new Date().toISOString(),
  };
  await events.append(
    {
      ...base,
      eventId: 'discover',
      type: 'discovered',
      source: {
        sourceMessageId: 'source',
        sourceThreadId: 'home',
        sourceCatId: 'codex',
        markerDigest: 'a'.repeat(64),
        sameDigestOrdinal: 0,
        markerIndex: 0,
      },
      backfilled: false,
      captureMethod: 'typed',
      captureAssessment: 'confirmed',
    },
    0,
  );
  const binding = { kind: 'task_assignment' as const, taskId: f.task.id, taskThreadId: 'home', ownerRevision: 0 };
  await f.store.update(f.task.id, { ownerCatId: 'sonnet' });
  await f.store.update(f.task.id, { ownerCatId: 'codex' });
  await assert.rejects(
    events.append(
      {
        ...base,
        eventId: 'stale-fix',
        type: 'fix',
        taskId: f.task.id,
        ownerCatId: 'codex',
        repairBinding: binding,
        custodyEvidenceRef: `task:${f.task.id}:assignment:0`,
      },
      1,
      { ...binding, ownerCatId: 'codex', userId: 'task-user', terminal: false },
    ),
    /assignment changed at event append/,
  );
  assert.equal((await events.read(base.signalId)).length, 1);
});

test('source withdrawal between proof and Task commit invalidates WATCH and never changes assignment', async (t) => {
  const f = await fixture(t);
  const messages = new RedisMessageStore(f.redis);
  const source = await messages.append({
    userId: 'task-user',
    threadId: 'home',
    from: { kind: 'agent', catId: 'codex' },
    content: 'accepted handoff',
    mentions: ['sonnet'],
    timestamp: Date.now(),
  });
  let enter!: () => void, resume!: () => void;
  const read = new Promise<void>((r) => {
      enter = r;
    }),
    release = new Promise<void>((r) => {
      resume = r;
    });
  let attempts = 0;
  const writing = f.store.mutateOrdinaryTask(
    {
      kind: 'handoff',
      taskId: f.task.id,
      expected: ordinaryTaskExpectation(f.task),
      ownerCatId: 'sonnet',
      messageRef: `message:${source.id}`,
    },
    {
      watchKeys: [`msg:${source.id}`],
      async assertCurrent() {
        const current = await messages.getById(source.id);
        if (current?.deletedAt) throw new Error('source withdrawn');
        if (++attempts === 1) {
          enter();
          await release;
        }
      },
    },
  );
  await read;
  await messages.softDelete(source.id, 'task-user');
  resume();
  await assert.rejects(writing, /source withdrawn/);
  assert.equal((await f.store.get(f.task.id))?.ownerCatId, 'codex');
});
