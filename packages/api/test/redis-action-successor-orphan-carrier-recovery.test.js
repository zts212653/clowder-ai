import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { RedisActionSuccessorLeaseStore } from '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { RedisActionSuccessorOrphanCarrierAtomicStore } from '../dist/domains/ball-custody/RedisActionSuccessorOrphanCarrierAtomicStore.js';
import { TaskActionSuccessorOrphanRecovery } from '../dist/domains/ball-custody/TaskActionSuccessorOrphanRecovery.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { buildCallbackPostMessageIdempotencyKey } from '../dist/domains/cats/services/agents/routing/callback-message-idempotency.js';
import { RedisInvocationRecordStore } from '../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { serializeTask } from '../dist/domains/cats/services/stores/redis/RedisTaskCodec.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { MessageKeys } from '../dist/domains/cats/services/stores/redis-keys/message-keys.js';
import { TaskKeys } from '../dist/domains/cats/services/stores/redis-keys/task-keys.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f167-orphan-carrier');
const ownerThreadId = 'thread-owner';
const childThreadId = 'thread-approved-child';
const ownerCatId = 'codex-astra';
const holderCatId = 'codex-sol';

function taskItem(taskId) {
  return {
    id: taskId,
    kind: 'work',
    threadId: ownerThreadId,
    subjectKey: `entrusted:${taskId}`,
    title: 'Recover an orphan carrier',
    ownerCatId,
    status: 'doing',
    why: 'approved Task child must continue once',
    createdBy: ownerCatId,
    createdAt: 1,
    updatedAt: 100,
    userId: 'user-1',
    entrustedWork: {
      revision: 12,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:human-source'],
        idempotencyKey: `${taskId}:admission`,
        receiptRef: `${taskId}:receipt`,
        admittedAt: 1,
      },
      developmentScope: {
        featureRef: 'feature:F167',
        phaseKey: 'R',
        workUnitRef: `task:work:${taskId}`,
        acceptedSourceRef: 'file:docs/features/F167-a2a-chain-quality.md',
        acceptedRevision: 'a'.repeat(40),
      },
      intendedOutcome: 'Recover the old carrier without a second writer',
      time: {},
      artifactRefs: [],
      closure: { state: 'open', condition: 'merged and loaded', expectedSignal: 'task_done', evidenceRefs: [] },
    },
  };
}

async function writeTask(redis, task) {
  await redis.hset(TaskKeys.detail(task.id), serializeTask(task));
}

async function fixture(t, options = {}) {
  const taskId = `task-${randomUUID()}`;
  const subjectRef = `subject:task:${taskId}`;
  const redis = owned.client(`orphan:${randomUUID()}:`);
  await redis.connect();
  t.after(() => redis.disconnect());
  const task = taskItem(taskId);
  await writeTask(redis, task);
  const messages = new RedisMessageStore(redis);
  const clientMessageId = `old-${taskId}`;
  const sourceInput = {
    threadId: childThreadId,
    userId: 'user-1',
    from: { kind: 'agent', catId: ownerCatId },
    content: 'Implement the approved Task exactly once',
    mentions: [holderCatId],
    origin: 'callback',
    timestamp: 101,
    deliveryStatus: 'queued',
    extra: {
      crossPost: { sourceThreadId: ownerThreadId, sourceInvocationId: 'owner-invocation' },
      coordination: { id: 'legacy-coordination', phase: 'active', hop: 0, subjectRef },
      targetCats: [holderCatId],
      stream: { invocationId: 'owner-parent', turnInvocationId: 'owner-invocation' },
      turnExecution: {
        invocationId: 'owner-invocation',
        parentInvocationId: 'owner-parent',
        executionKind: 'ordinary',
      },
    },
  };
  const source = options.legacySource
    ? await messages.append(sourceInput)
    : (
        await messages.appendIdempotent({
          ...sourceInput,
          idempotencyKey: buildCallbackPostMessageIdempotencyKey(ownerCatId, clientMessageId),
        })
      ).message;
  await messages.markDelivered(source.id, 110);
  // The production orphan is a legacy published Agent source: deliveredAt exists but the status field may be absent.
  await redis.hdel(MessageKeys.detail(source.id), 'deliveryStatus');

  const leases = new RedisActionSuccessorLeaseStore(redis);
  const predicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef,
    predicate: { kind: 'task_done' },
  });
  const claimed = await leases.claim({
    leaseId: `lease-${taskId}`,
    tenantScope: 'user-1',
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [holderCatId],
    dispatchId: `cross-post:${clientMessageId}`,
    claimOrigin: 'structured_transfer',
    holderThreadId: childThreadId,
    predecessorCatId: ownerCatId,
    predecessorThreadId: ownerThreadId,
    issuerStandingEvidenceRef: `callback:owner-invocation:${clientMessageId}`,
    evidenceRefs: [
      `callback:owner-invocation:${clientMessageId}`,
      `proposal:proposal-721:approved:thread:${childThreadId}:cat:${holderCatId}`,
    ],
    terminalPredicate: predicate,
    now: 100,
  });
  assert.equal(claimed.outcome, 'claimed');

  const ledger = new RedisQueueLedgerStore(redis);
  let admissionNotifications = 0;
  const queue = new InvocationQueue(ledger, {
    onAdmitted() {
      admissionNotifications++;
    },
  });
  await queue.hydrateFromLedger(messages);
  const atomic = new RedisActionSuccessorOrphanCarrierAtomicStore(redis);
  let lastAtomicInput;
  const deps = {
    tasks: new RedisTaskStore(redis),
    messages,
    queue,
    invocationRecords: new RedisInvocationRecordStore(redis),
    turnExecutions: new RedisTurnExecutionStore(redis),
    delegates: {
      async getForTask() {
        return [
          {
            catId: holderCatId,
            threadId: childThreadId,
            evidenceRef: `proposal:proposal-721:approved:thread:${childThreadId}:cat:${holderCatId}`,
          },
        ];
      },
    },
    atomicStore: {
      async commit(input) {
        lastAtomicInput = input;
        return atomic.commit(input);
      },
    },
  };
  const service = new TaskActionSuccessorOrphanRecovery(deps);
  const action = {
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    terminalPredicate: { kind: 'task_done' },
  };
  const admission = (suffix) => ({
    tenantScope: 'user-1',
    actorCatId: ownerCatId,
    sourceThreadId: ownerThreadId,
    targetThreadId: childThreadId,
    holderCatIds: [holderCatId],
    dispatchId: `cross-post:recover-${suffix}`,
    evidenceRef: `callback:new:recover-${suffix}`,
    now: 200,
    action,
  });
  return {
    redis,
    task,
    source,
    leases,
    ledger,
    queue,
    atomic,
    service,
    deps,
    admission,
    claimed,
    get lastAtomicInput() {
      return lastAtomicInput;
    },
    get admissionNotifications() {
      return admissionNotifications;
    },
  };
}

async function captureAtomicInput(f, suffix) {
  let captured;
  const captureOnly = new TaskActionSuccessorOrphanRecovery({
    ...f.deps,
    atomicStore: {
      async commit(input) {
        captured = input;
        return { outcome: 'rejected', reason: 'store_corrupt' };
      },
    },
  });
  await captureOnly.recover({
    lease: f.claimed.lease,
    admissionInput: f.admission(suffix),
    ownerAuthProvenance: 'strict',
  });
  assert.ok(captured);
  return captured;
}

test('orphan recovery commits generation + original Message lifecycle + Queue row together and survives restart', async (t) => {
  const f = await fixture(t);
  const result = await f.service.recover({
    lease: f.claimed.lease,
    admissionInput: f.admission('one'),
    ownerAuthProvenance: 'strict',
    parentInvocationId: 'owner-parent',
  });

  assert.equal(result.outcome, 'recovered');
  assert.equal(result.lease.generation, 2);
  const oldFence = await f.leases.preflight(f.claimed.lease.leaseId, 1, f.claimed.lease.terminalPredicate.digest);
  assert.deepEqual(oldFence, { ok: false, reason: 'stale_generation' });
  const persistedSource = await new RedisMessageStore(f.redis).getById(f.source.id);
  assert.equal(persistedSource.lifecycle.kind, 'input');
  assert.equal(persistedSource.lifecycle.dispatchRefs.length, 0);
  assert.equal((await f.ledger.list(childThreadId)).length, 1);
  assert.equal(f.queue.list(childThreadId, 'user-1').length, 1);

  const restarted = new InvocationQueue(new RedisQueueLedgerStore(f.redis));
  assert.equal(await restarted.hydrateFromLedger(new RedisMessageStore(f.redis)), 1);
  const [recovered] = restarted.list(childThreadId, 'user-1');
  assert.equal(recovered.execution.actionSuccessorFence.generation, 2);
  assert.deepEqual(recovered.targets, [holderCatId]);

  const replay = await f.atomic.commit(f.lastAtomicInput);
  assert.equal(replay.outcome, 'replayed');
  assert.equal((await f.ledger.list(childThreadId)).length, 1);
});

test('pre-durable callback source without an idempotency index is recovered and indexed atomically', async (t) => {
  const f = await fixture(t, { legacySource: true });
  const sourceKey = buildCallbackPostMessageIdempotencyKey(ownerCatId, `old-${f.task.id}`);
  assert.equal(
    await f.deps.messages.getByIdempotencyKey('user-1', childThreadId, sourceKey),
    null,
    'the production legacy shape has no callback idempotency index',
  );
  for (let index = 0; index < 205; index++) {
    await f.deps.messages.append({
      threadId: childThreadId,
      userId: 'user-1',
      from: { kind: 'user', userId: 'user-1' },
      content: `newer thread history ${index}`,
      mentions: [],
      timestamp: 1_000 + index,
    });
  }

  const result = await f.service.recover({
    lease: f.claimed.lease,
    admissionInput: f.admission('legacy-source'),
    ownerAuthProvenance: 'strict',
    parentInvocationId: 'owner-parent',
  });

  assert.equal(result.outcome, 'recovered');
  assert.equal(result.messageId, f.source.id);
  assert.equal(
    (await f.deps.messages.getByIdempotencyKey('user-1', childThreadId, sourceKey))?.id,
    f.source.id,
    'the one atomic recovery backfills the durable identity of the original Message',
  );
  assert.equal((await f.ledger.list(childThreadId)).length, 1);

  const current = await f.leases.get(f.claimed.lease.leaseId);
  const replay = await f.service.recover({
    lease: current,
    admissionInput: f.admission('legacy-source'),
    ownerAuthProvenance: 'strict',
    parentInvocationId: 'owner-parent',
  });
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.messageId, f.source.id);
  assert.equal((await f.ledger.list(childThreadId)).length, 1);
});

test('multiple pre-durable callback sources from the same callback invocation fail closed', async (t) => {
  const f = await fixture(t, { legacySource: true });
  const second = await f.deps.messages.append({
    threadId: childThreadId,
    userId: 'user-1',
    from: { kind: 'agent', catId: ownerCatId },
    content: 'A second legacy source from the same callback turn',
    mentions: [holderCatId],
    origin: 'callback',
    timestamp: 102,
    deliveryStatus: 'queued',
    extra: {
      crossPost: { sourceThreadId: ownerThreadId, sourceInvocationId: 'owner-invocation' },
      targetCats: [holderCatId],
      stream: { invocationId: 'owner-parent', turnInvocationId: 'owner-invocation' },
      turnExecution: {
        invocationId: 'owner-invocation',
        parentInvocationId: 'owner-parent',
        executionKind: 'ordinary',
      },
    },
  });
  await f.deps.messages.markDelivered(second.id, 111);

  assert.deepEqual(
    await f.service.recover({
      lease: f.claimed.lease,
      admissionInput: f.admission('ambiguous'),
      ownerAuthProvenance: 'strict',
    }),
    { outcome: 'refused', reason: 'source_ambiguous' },
  );
  assert.equal((await f.ledger.list(childThreadId)).length, 0);
  assert.equal((await f.leases.get(f.claimed.lease.leaseId)).generation, 1);
});

test('a competing legacy callback identity claim rejects the atomic commit', async (t) => {
  const f = await fixture(t, { legacySource: true });
  const captured = await captureAtomicInput(f, 'legacy-identity-race');
  await f.redis.set(
    MessageKeys.idempotency(
      'user-1',
      childThreadId,
      buildCallbackPostMessageIdempotencyKey(ownerCatId, `old-${f.task.id}`),
    ),
    'different-source',
  );

  assert.deepEqual(await f.atomic.commit(captured), { outcome: 'rejected', reason: 'source_changed' });
  assert.equal((await f.leases.get(f.claimed.lease.leaseId)).generation, 1);
  assert.equal((await f.ledger.list(childThreadId)).length, 0);
  assert.equal((await f.deps.messages.getById(f.source.id)).lifecycle, undefined);
});

test('same-request replay adopts a committed orphan row whose in-process wake was lost', async (t) => {
  const f = await fixture(t);
  const captured = await captureAtomicInput(f, 'lost-adoption');
  assert.equal((await f.atomic.commit(captured)).outcome, 'committed');
  assert.equal((await f.ledger.list(childThreadId)).length, 1);
  assert.equal(f.queue.list(childThreadId, 'user-1').length, 0, 'the simulated process has not adopted the row');
  assert.equal(f.admissionNotifications, 0);
  const current = await f.leases.get(f.claimed.lease.leaseId);
  assert.ok(current);

  const replay = await f.service.recover({
    lease: current,
    admissionInput: f.admission('lost-adoption'),
    ownerAuthProvenance: 'strict',
  });

  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.messageId, f.source.id);
  assert.equal(f.queue.list(childThreadId, 'user-1').length, 1);
  assert.equal(f.admissionNotifications, 1, 'replay must emit the ordinary drain wake exactly once');
  assert.equal((await f.ledger.list(childThreadId)).length, 1, 'replay never creates a second durable writer');
});

test('two concurrent owner recoveries produce one new generation and one Queue writer', async (t) => {
  const f = await fixture(t);
  const [left, right] = await Promise.all([
    f.service.recover({
      lease: f.claimed.lease,
      admissionInput: f.admission('left'),
      ownerAuthProvenance: 'strict',
    }),
    f.service.recover({
      lease: f.claimed.lease,
      admissionInput: f.admission('right'),
      ownerAuthProvenance: 'strict',
    }),
  ]);

  assert.equal([left, right].filter((result) => result.outcome === 'recovered').length, 1);
  assert.equal((await f.leases.get(f.claimed.lease.leaseId)).generation, 2);
  assert.equal((await f.ledger.list(childThreadId)).length, 1);
});

test('task revision drift rejects the atomic commit without changing lease, Message, or Queue', async (t) => {
  const g = await fixture(t);
  const captured = await captureAtomicInput(g, 'drift');
  const drifted = { ...g.task, entrustedWork: { ...g.task.entrustedWork, revision: 13 } };
  await writeTask(g.redis, drifted);
  const rejected = await g.atomic.commit(captured);
  assert.deepEqual(rejected, { outcome: 'rejected', reason: 'task_changed' });
  assert.equal((await g.leases.get(g.claimed.lease.leaseId)).generation, 1);
  assert.equal((await g.ledger.list(childThreadId)).length, 0);
  assert.equal((await new RedisMessageStore(g.redis).getById(g.source.id)).lifecycle, undefined);
});

test('same-revision scope, lease identity, source, and execution races all fail closed', async (t) => {
  const scope = await fixture(t);
  const scopeInput = await captureAtomicInput(scope, 'scope-drift');
  await writeTask(scope.redis, {
    ...scope.task,
    entrustedWork: {
      ...scope.task.entrustedWork,
      developmentScope: {
        ...scope.task.entrustedWork.developmentScope,
        acceptedRevision: 'b'.repeat(40),
      },
    },
  });
  assert.deepEqual(await scope.atomic.commit(scopeInput), { outcome: 'rejected', reason: 'task_changed' });

  const identity = await fixture(t);
  const identityInput = await captureAtomicInput(identity, 'identity-drift');
  const rawLease = JSON.parse(await identity.redis.get(ActionSuccessorKeys.detail(identity.claimed.lease.leaseId)));
  await identity.redis.set(
    ActionSuccessorKeys.detail(identity.claimed.lease.leaseId),
    JSON.stringify({ ...rawLease, holderThreadId: 'thread-other-child' }),
  );
  assert.deepEqual(await identity.atomic.commit(identityInput), {
    outcome: 'rejected',
    reason: 'identity_mismatch',
  });

  const outcome = await fixture(t);
  const outcomeInput = await captureAtomicInput(outcome, 'outcome-race');
  const outcomeLease = JSON.parse(await outcome.redis.get(ActionSuccessorKeys.detail(outcome.claimed.lease.leaseId)));
  await outcome.redis.set(
    ActionSuccessorKeys.detail(outcome.claimed.lease.leaseId),
    JSON.stringify({
      ...outcomeLease,
      holderOutcomes: { [holderCatId]: { outcome: 'failed', evidenceRef: 'invocation:late', at: 199 } },
    }),
  );
  assert.deepEqual(await outcome.atomic.commit(outcomeInput), {
    outcome: 'rejected',
    reason: 'identity_mismatch',
  });

  const source = await fixture(t);
  const sourceInput = await captureAtomicInput(source, 'source-drift');
  await source.redis.hset(MessageKeys.detail(source.source.id), 'deletedAt', '201');
  assert.deepEqual(await source.atomic.commit(sourceInput), { outcome: 'rejected', reason: 'source_changed' });

  const execution = await fixture(t);
  const executionInput = await captureAtomicInput(execution, 'execution-race');
  await execution.deps.invocationRecords.create({
    threadId: childThreadId,
    userId: 'user-1',
    targetCats: [holderCatId],
    intent: 'execute',
    idempotencyKey: executionInput.canonicalInvocationKey,
    actionLeaseCarrier: {
      kind: 'action_successor',
      leaseId: execution.claimed.lease.leaseId,
      generation: execution.claimed.lease.generation,
    },
  });
  assert.deepEqual(await execution.atomic.commit(executionInput), {
    outcome: 'rejected',
    reason: 'execution_present',
  });

  for (const current of [scope, identity, outcome, source, execution]) {
    assert.equal((await current.ledger.list(childThreadId)).length, 0);
    assert.equal((await new RedisMessageStore(current.redis).getById(current.source.id)).lifecycle, undefined);
  }
});
