import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTypedWaitRegistration } from '../src/domains/ball-custody/TypedWaitRegistration.ts';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.ts';
import { hydrateTask, serializeTask } from '../src/domains/cats/services/stores/redis/RedisTaskCodec.ts';
import { DeploymentWaitLifecycleService } from '../src/domains/runtime-deployment/DeploymentWaitLifecycleService.ts';
import { DeploymentWaitStartGuard } from '../src/domains/runtime-deployment/DeploymentWaitStartGuard.ts';
import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

const revision = '1'.repeat(40);
const observation = {
  subjectRef: 'deployment:owned:isolated',
  bootId: 'owned-boot',
  bootSequence: 2,
  runningRevision: revision,
  readyServices: ['api', 'web'],
  observedAt: 100,
  inclusionProof: { kind: 'git_ancestry', targetRevision: revision, runningRevision: revision, included: true },
};
async function fixture({ current = true } = {}) {
  const tasks = new TaskStore();
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const executions = new InMemoryTurnExecutionStore();
  const task = tasks.create({
    kind: 'work',
    threadId: 'owned-thread',
    userId: 'owned-user',
    ownerCatId: 'opus',
    createdBy: 'opus',
    title: 'isolated deployment wait',
    why: 'C5 integration seam',
  });
  const claim = { invocationId: 'owned-child', generation: 1, bootId: 'owned-boot' };
  const active = {
    v: 1,
    generation: 1,
    subjectRef: observation.subjectRef,
    ownerFence: { kind: 'containing_task', generation: 1 },
    baseline: { bootId: 'before', bootSequence: 1, capturedAt: 1 },
    continuation: {
      when: [{ kind: 'revision_included', revision, services: ['api', 'web'] }],
      // biome-ignore lint/suspicious/noThenProperty: bounded wait contract field.
      then: 'verify this deployment only',
    },
    autoRenew: false,
    createdAt: 1,
  };
  const receipt = createTypedWaitRegistration({
    task,
    active,
    invocationId: claim.invocationId,
    source: { kind: 'primary', sourceMessageId: 'owned-origin' },
  });
  assert.ok(
    tasks.replaceDeploymentWaitIfGeneration(task.id, {
      expectedGeneration: null,
      expectedDeploymentWait: undefined,
      deploymentWait: { await: active, ...(current ? { currentExecutionClaim: claim } : {}) },
      waitRegistration: receipt,
      status: 'blocked',
    }),
  );
  executions.createRunning({
    invocationId: claim.invocationId,
    parentInvocationId: 'owned-parent',
    userId: task.userId,
    threadId: task.threadId,
    catId: task.ownerCatId,
    executionKind: 'ordinary',
    startedAt: 10,
  });
  let progressed = 0;
  const delivery = new PersistedQueueDelivery({
    messages,
    queue,
    progress: async () => {
      progressed++;
      return 'owned_deferred_busy';
    },
  });
  const options = {
    taskStore: tasks,
    messageStore: messages,
    deliveryDeps: { delivery },
    turnExecutionStore: executions,
    currentObservation: async () => observation,
    bootId: 'owned-boot',
    log: { info() {}, warn() {}, error() {} },
  };
  const lifecycle = new DeploymentWaitLifecycleService(options);
  const immediate = () =>
    lifecycle.observe({ taskId: task.id, observation, currentInvocationId: claim.invocationId, wakeOwner: false });
  const state = () => tasks.get(task.id).deploymentWait;
  const entries = () => queue.list(task.threadId, task.userId);
  const terminal = (status = 'failed') =>
    executions.transitionTerminal(claim.invocationId, { status, endedAt: 101, terminalReason: 'owned-test-terminal' });
  return {
    tasks,
    messages,
    queue,
    executions,
    task,
    claim,
    options,
    lifecycle,
    immediate,
    state,
    entries,
    terminal,
    get progressed() {
      return progressed;
    },
  };
}

test('C5 immediate current-child receipt publishes History but admits no Queue or second wake', async () => {
  const f = await fixture();
  const result = await f.immediate();
  assert.equal(result.kind, 'notified');
  assert.equal(f.entries().length, 0);
  assert.equal(f.progressed, 0);
  assert.equal(f.state().currentExecutionReceipt.messageId, result.messageId);
  assert.equal(f.state().currentExecutionReceipt.invocationId, f.claim.invocationId);
  assert.deepEqual(f.state().currentExecutionClaim, f.claim);
  assert.equal(
    f.messages.getById(result.messageId).lifecycle?.dispatchRefs?.length ?? 0,
    0,
    'History persistence is not a model-read receipt',
  );
});

test('C5 failed child recovery has one distinct immutable transport linked to the original notification', async () => {
  const f = await fixture();
  const current = await f.immediate();
  const original = structuredClone(f.messages.getById(current.messageId));
  f.terminal();
  const workers = [f.lifecycle, new DeploymentWaitLifecycleService({ ...f.options, bootId: 'later-boot' })];
  const recovered = await Promise.all(workers.map((w) => w.recoverOutcome(f.task.id)));
  const result = recovered.find((r) => r.kind === 'notified');
  assert.ok(result);
  assert.notEqual(result.messageId, current.messageId);
  assert.equal(result.outcome.outcomeId, current.outcome.outcomeId);
  assert.equal(f.entries().length, 1);
  assert.deepEqual(f.messages.getById(current.messageId), original);
  assert.equal(f.state().recoverySource.invocationId, f.claim.invocationId);
  assert.equal(f.state().currentExecutionReceipt.messageId, current.messageId);
  assert.equal(f.state().transportAttempt.messageId, result.messageId);
  assert.equal(f.entries()[0].execution.waitContinuationCarrier.outcomeId, current.outcome.outcomeId);
  await f.lifecycle.recoverOutcome(f.task.id);
  assert.equal(f.entries().length, 1);
});

test('C5 successful current child settles without a new transport or business task completion', async () => {
  const f = await fixture();
  await f.immediate();
  f.terminal('succeeded');
  assert.equal((await f.lifecycle.recoverOutcome(f.task.id)).kind, 'state_only');
  assert.equal(f.entries().length, 0);
  assert.equal(f.state().transportAttempt, undefined);
  assert.equal(f.tasks.get(f.task.id).status, 'blocked');
});

for (const proof of ['running', 'missing', 'throws', 'wrong-scope']) {
  test(`C5 later boot with ${proof} child proof cannot allocate a recovery transport`, async () => {
    const f = await fixture();
    await f.immediate();
    const old = f.executions.get(f.claim.invocationId);
    const read =
      proof === 'running'
        ? async () => old
        : proof === 'missing'
          ? async () => null
          : proof === 'throws'
            ? async () => {
                throw Error('owned lookup unavailable');
              }
            : async () => ({ ...old, status: 'failed', userId: 'other-user' });
    const recovery = new DeploymentWaitLifecycleService({
      ...f.options,
      bootId: 'later-boot',
      turnExecutionStore: { get: read },
    });
    assert.equal((await recovery.recoverOutcome(f.task.id)).kind, 'state_only');
    assert.equal(f.entries().length, 0);
    assert.deepEqual(f.state().currentExecutionClaim, f.claim);
  });
}

test('C5 unknown History commit retains current claim, then links its committed notice on legal recovery', async () => {
  const f = await fixture();
  const append = f.messages.appendIdempotent.bind(f.messages);
  let thrown = false;
  f.messages.appendIdempotent = (input) => {
    const result = append(input);
    if (!thrown) {
      thrown = true;
      throw Error('owned History reply lost');
    }
    return result;
  };
  await assert.rejects(f.immediate(), /History reply lost/);
  const history = f.messages.getByThread(f.task.threadId);
  assert.equal(history.length, 1);
  assert.equal(f.entries().length, 0);
  assert.deepEqual(f.state().currentExecutionClaim, f.claim);
  assert.equal((await f.lifecycle.recoverOutcome(f.task.id)).kind, 'state_only');
  f.terminal();
  assert.equal((await f.lifecycle.recoverOutcome(f.task.id)).kind, 'notified');
  assert.equal(f.state().currentExecutionReceipt.messageId, history[0].id);
  assert.equal(f.entries().length, 1);
});

test('C5 lost Task acknowledgement after Queue commit retries the same attempt and Message', async () => {
  const f = await fixture();
  await f.immediate();
  f.terminal();
  const replace = f.tasks.replaceDeploymentWaitIfGeneration.bind(f.tasks);
  let refuseAcknowledgement = true;
  f.tasks.replaceDeploymentWaitIfGeneration = (id, input) =>
    refuseAcknowledgement && input.deploymentWait?.transportAttempt?.messageId ? null : replace(id, input);
  await f.lifecycle.recoverOutcome(f.task.id);
  assert.equal(f.entries().length, 1);
  const admittedId = f.entries()[0].payload.messageId;
  const key = f.state().transportAttempt.idempotencyKey;
  assert.equal(f.state().waitOutcome.delivery, 'pending');
  refuseAcknowledgement = false;
  const retry = await new DeploymentWaitLifecycleService({ ...f.options, bootId: 'another-boot' }).recoverOutcome(
    f.task.id,
  );
  assert.equal(retry.messageId, admittedId);
  assert.equal(f.state().transportAttempt.idempotencyKey, key);
  assert.equal(f.entries().length, 1);
});

for (const receiptProof of ['unavailable', 'wrong-scope']) {
  test(`C5 ${receiptProof} History lookup cannot clear a terminal child's claim`, async () => {
    const f = await fixture();
    const append = f.messages.appendIdempotent.bind(f.messages);
    f.messages.appendIdempotent = (input) => {
      append(input);
      throw Error('owned History reply lost');
    };
    await assert.rejects(f.immediate(), /History reply lost/);
    f.terminal();
    const lookup = f.messages.getByIdempotencyKey.bind(f.messages);
    f.messages.getByIdempotencyKey = (...args) => {
      if (receiptProof === 'unavailable') throw Error('owned receipt lookup unavailable');
      return { ...lookup(...args), userId: 'other-user' };
    };
    assert.equal((await f.lifecycle.recoverOutcome(f.task.id)).kind, 'state_only');
    assert.deepEqual(f.state().currentExecutionClaim, f.claim);
    assert.equal(f.state().transportAttempt, undefined);
    assert.equal(f.entries().length, 0);
  });
}

test('C5 a legacy matched claim without publication association remains unverified, not rebound', async () => {
  const f = await fixture();
  await f.immediate();
  const old = f.tasks.get(f.task.id);
  const { currentExecutionReceipt, ...legacy } = old.deploymentWait;
  assert.ok(
    f.tasks.replaceDeploymentWaitIfGeneration(f.task.id, {
      expectedGeneration: 1,
      expectedDeploymentWait: old.deploymentWait,
      deploymentWait: legacy,
    }),
  );
  f.terminal();
  assert.equal((await f.lifecycle.recoverOutcome(f.task.id)).kind, 'state_only');
  assert.deepEqual(f.state().currentExecutionClaim, f.claim);
  assert.equal(f.entries().length, 0);
});

test('C5 non-admission leaves the same allocated identity pending for retry', async () => {
  const f = await fixture({ current: false });
  const deliver = f.options.deliveryDeps.delivery.deliver.bind(f.options.deliveryDeps.delivery);
  f.options.deliveryDeps.delivery.deliver = async () => ({ state: 'unavailable' });
  assert.equal((await f.lifecycle.observe({ taskId: f.task.id, observation })).kind, 'state_only');
  assert.equal(f.state().waitOutcome.delivery, 'pending');
  const key = f.state().transportAttempt.idempotencyKey;
  f.options.deliveryDeps.delivery.deliver = deliver;
  assert.equal((await f.lifecycle.recoverOutcome(f.task.id)).kind, 'notified');
  assert.equal(f.state().transportAttempt.idempotencyKey, key);
  assert.equal(f.entries().length, 1);
});

test('C5 recovery allocation CAS loss cannot clear the claim or publish Queue work', async () => {
  const f = await fixture();
  await f.immediate();
  f.terminal();
  const replace = f.tasks.replaceDeploymentWaitIfGeneration.bind(f.tasks);
  f.tasks.replaceDeploymentWaitIfGeneration = (id, input) =>
    input.deploymentWait?.recoverySource ? null : replace(id, input);
  assert.equal((await f.lifecycle.recoverOutcome(f.task.id)).kind, 'state_only');
  assert.deepEqual(f.state().currentExecutionClaim, f.claim);
  assert.equal(f.state().transportAttempt, undefined);
  assert.equal(f.entries().length, 0);
});

test('C5 publication identities survive the actual Task Redis codec without creating a second owner', async () => {
  const f = await fixture();
  await f.immediate();
  f.terminal();
  await f.lifecycle.recoverOutcome(f.task.id);
  const stored = f.tasks.get(f.task.id);
  const restored = hydrateTask(serializeTask(stored));
  assert.deepEqual(restored.deploymentWait, stored.deploymentWait);
  const { transportAttempt, ...rest } = stored.deploymentWait;
  assert.equal(
    f.tasks.replaceDeploymentWaitIfGeneration(f.task.id, {
      expectedGeneration: 1,
      expectedDeploymentWait: { ...rest, transportAttempt: { ...transportAttempt, messageId: 'stale' } },
      deploymentWait: stored.deploymentWait,
    }),
    null,
    'CAS includes the full attempt receipt',
  );
});

test('C5 recovered typed wait remains excluded from ordinary full-body adoption', async () => {
  const f = await fixture();
  await f.immediate();
  f.terminal();
  const recovered = await f.lifecycle.recoverOutcome(f.task.id);
  const row = f.entries()[0];
  assert.deepEqual(
    f.queue.getQueuedBodyMessagesForCat(f.task.threadId, f.task.userId, f.task.ownerCatId, 'other-parent'),
    [],
  );
  assert.equal(
    await f.queue.claimExactExposureDurable(
      f.task.threadId,
      f.task.userId,
      row.id,
      f.task.ownerCatId,
      recovered.messageId,
    ),
    null,
  );
  assert.equal(f.entries().length, 1);
});

test('C5 lost acknowledgement after actual target retirement reuses the admitted receipt, not a new attempt', async () => {
  const f = await fixture({ current: false });
  const replace = f.tasks.replaceDeploymentWaitIfGeneration.bind(f.tasks);
  f.tasks.replaceDeploymentWaitIfGeneration = (id, input) =>
    input.deploymentWait?.transportAttempt?.messageId ? null : replace(id, input);
  await f.lifecycle.observe({ taskId: f.task.id, observation });
  const row = f.entries()[0];
  const originalKey = f.state().transportAttempt.idempotencyKey;
  const response = appendTestLifecycleResponseSource(f.messages, {
    invocationId: 'owned-recovery-child',
    threadId: f.task.threadId,
    userId: f.task.userId,
    catId: f.task.ownerCatId,
    timestamp: 200,
  });
  assert.ok(await f.queue.markProcessingByIdDurable(f.task.threadId, row.id, f.task.ownerCatId));
  assert.equal(
    f.messages.commitLifecycleAppendAdmission({
      threadId: f.task.threadId,
      entryId: row.id,
      inputMessageIds: [row.payload.messageId],
      runs: [
        {
          targetId: f.task.ownerCatId,
          invocationId: 'owned-recovery-child',
          responseMessageId: response.id,
          dispatchedAt: 201,
        },
      ],
    }).kind,
    'applied',
  );
  assert.equal(
    (await f.queue.retireClaimedLifecycleTarget(f.task.threadId, row.id, f.task.ownerCatId, 201)).outcome,
    'retired',
  );
  assert.equal(f.entries().length, 0);
  f.tasks.replaceDeploymentWaitIfGeneration = replace;
  const retry = await f.lifecycle.recoverOutcome(f.task.id);
  assert.equal(retry.messageId, row.payload.messageId);
  assert.equal(f.state().transportAttempt.idempotencyKey, originalKey);
  assert.equal(f.entries().length, 0);
  assert.equal(f.progressed, 1);
});

test('C5 cancellation after allocation/commit and version rollback are rejected at actual start guard', async () => {
  const f = await fixture({ current: false });
  const deliver = f.options.deliveryDeps.delivery.deliver.bind(f.options.deliveryDeps.delivery);
  f.options.deliveryDeps.delivery.deliver = async (input) => {
    const admitted = await deliver(input);
    await f.tasks.update(f.task.id, { status: 'done' });
    return admitted;
  };
  assert.equal((await f.lifecycle.observe({ taskId: f.task.id, observation })).kind, 'state_only');
  const source = f.entries()[0].payload.messageId;
  const guard = new DeploymentWaitStartGuard({
    taskStore: f.tasks,
    messageStore: f.messages,
    observationProvider: { observe: async () => observation },
  });
  assert.equal(
    await guard.canStart({
      messageId: source,
      threadId: f.task.threadId,
      userId: f.task.userId,
      catId: f.task.ownerCatId,
    }),
    false,
  );
  const g = await fixture({ current: false });
  const result = await g.lifecycle.observe({ taskId: g.task.id, observation });
  const rollback = new DeploymentWaitStartGuard({
    taskStore: g.tasks,
    messageStore: g.messages,
    observationProvider: { observe: async () => ({ ...observation, readyServices: [] }) },
  });
  assert.equal(
    await rollback.canStart({
      messageId: result.messageId,
      threadId: g.task.threadId,
      userId: g.task.userId,
      catId: g.task.ownerCatId,
    }),
    false,
  );
  assert.equal((await g.lifecycle.recoverOutcome(g.task.id)).messageId, result.messageId);
  assert.equal(g.entries().length, 1);
});
