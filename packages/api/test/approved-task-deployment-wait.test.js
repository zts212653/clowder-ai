import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { DeploymentWaitStartGuard } from '../dist/domains/runtime-deployment/DeploymentWaitStartGuard.js';
import { approvedTaskFixture, OWNER, TARGET, USER } from './helpers/approved-task-contract-fixture.js';
import { connectorDeliveryHarness } from './helpers/connector-delivery-harness.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const isolation = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };

test(
  'approved repair preserves the original deployment wait and a matched wake binds only after it stops',
  isolation,
  async (t) => {
    const generation = 1;
    const subjectRef = 'deployment:abc123def456:runtime';
    const f = await approvedTaskFixture(t, {
      autoStart: true,
      legacy: false,
      async beforeApprove({ approve, auth, tasks, task, origin }) {
        const active = {
          v: 1,
          generation,
          subjectRef,
          ownerFence: { kind: 'containing_task', generation },
          baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
          continuation: {
            when: [{ kind: 'new_ready_boot', services: ['api'] }],
            // biome-ignore lint/suspicious/noThenProperty: Frozen deployment continuation contract.
            then: 'Verify in the original conversation.',
          },
          autoRenew: false,
          createdAt: 100,
        };
        const receipt = createTypedWaitRegistration({
          task,
          active,
          invocationId: auth.invocationId,
          source: { kind: 'primary', sourceMessageId: origin.id },
          authorization: { ownerAuthProvenance: 'strict' },
        });
        assert.ok(receipt);
        assert.ok(
          await tasks.replaceDeploymentWaitIfGeneration(task.id, {
            expectedGeneration: null,
            expectedDeploymentWait: undefined,
            deploymentWait: { await: active },
            waitRegistration: receipt,
            status: 'blocked',
          }),
        );
        return approve();
      },
    });
    const [entry] = await f.queue.listAllDurable(f.childId);
    const seedId = entry.payload.messageId;
    const actor = { userId: USER, catId: TARGET, threadId: f.childId, invocationId: 'approved-repair' };
    const parent = 'repair-parent';
    await f.turns.createRunning({
      ...actor,
      parentInvocationId: parent,
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    assert.equal(await f.handoffs.start(seedId, actor, parent), f.task.id);
    assert.equal((await f.tasks.get(f.task.id)).deploymentWait.await.generation, generation);

    const observation = {
      subjectRef,
      bootId: 'boot-2',
      bootSequence: 2,
      runningRevision: '1'.repeat(40),
      readyServices: ['api'],
      observedAt: 500,
    };
    const connector = connectorDeliveryHarness({
      messageStore: f.messages,
      ledgerStore: new RedisQueueLedgerStore(f.redis),
    });
    const lifecycle = new DeploymentWaitLifecycleService({
      taskStore: f.tasks,
      messageStore: f.messages,
      deliveryDeps: connector.deliveryDeps,
      currentObservation: async () => observation,
      log: { info() {}, warn() {}, error() {} },
    });
    assert.equal((await lifecycle.observe({ taskId: f.task.id, observation })).kind, 'state_only');
    const pending = await f.tasks.get(f.task.id);
    assert.equal(pending.deploymentWait.waitOutcome.delivery, 'pending');
    assert.equal(pending.deploymentWait.transportAttempt, undefined);
    assert.equal(connector.wakes.length, 0);

    await f.turns.transitionTerminal(actor.invocationId, {
      status: 'succeeded',
      endedAt: Date.now(),
      providerTeardownAt: Date.now(),
    });
    const seed = await f.messages.getById(seedId);
    const lifecycleIdentity = {
      orderKey: seed.lifecycle.orderKey,
      ...(seed.lifecycle.producerInvocationId ? { producerInvocationId: seed.lifecycle.producerInvocationId } : {}),
      targetId: TARGET,
      statusMessageId: 'verified-repair-output',
    };
    await f.messages.advanceLifecycleInputDispatch(seedId, {
      ...lifecycleIdentity,
      phase: 'dispatched',
      dispatchedAt: 505,
    });
    await f.messages.advanceLifecycleInputDispatch(seedId, { ...lifecycleIdentity, phase: 'settled' });
    await f.handoffs.finish(f.task.id, actor.invocationId);
    const notified = await lifecycle.recoverOutcome(f.task.id);
    assert.equal(notified.kind, 'notified', JSON.stringify(notified));
    assert.equal(connector.wakes.length, 1);
    const wake = await f.messages.getById(notified.messageId);
    assert.equal(wake.source.meta.taskHandoffRef, `message:${seedId}`);
    const stale = await f.messages.append({
      from: { kind: 'external', connectorId: 'deployment-wait' },
      userId: USER,
      threadId: f.source.id,
      timestamp: Date.now(),
      content: wake.content,
      mentions: [OWNER],
      source: { ...wake.source, meta: { waitContinuationCarrier: wake.source.meta.waitContinuationCarrier } },
    });
    const guard = new DeploymentWaitStartGuard({
      taskStore: f.tasks,
      messageStore: f.messages,
      observationProvider: { observe: async () => observation },
    });
    const startIdentity = { userId: USER, threadId: f.source.id, catId: OWNER };
    assert.equal((await guard.check({ ...startIdentity, messageId: stale.id })).ok, false);
    await assert.rejects(
      f.handoffs.start(stale.id, { ...startIdentity, invocationId: 'stale-owner' }, 'old-parent'),
      /task_deployment_wake_assignment_changed/,
    );
    assert.equal((await guard.check({ ...startIdentity, messageId: wake.id })).ok, true);
    await f.handoffs.start(wake.id, { ...startIdentity, invocationId: 'matching-owner' }, 'owner-parent');
    assert.equal((await f.tasks.get(f.task.id)).executionRef.sourceMessageId, wake.id);
    assert.equal((await f.tasks.get(f.task.id)).status, 'blocked');
  },
);
