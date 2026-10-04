import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  createTypedWaitRegistration,
  isLiveTypedWaitRegistration,
} from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { WaitContinuationRetryPreflight } from '../dist/domains/ball-custody/WaitContinuationRetryPreflight.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { DeploymentWaitRecoverySweep } from '../dist/domains/runtime-deployment/DeploymentWaitRecoverySweep.js';
import { DeploymentWaitStartGuard } from '../dist/domains/runtime-deployment/DeploymentWaitStartGuard.js';

const TARGET_REVISION = '1'.repeat(40);
const RUNNING_REVISION = '2'.repeat(40);
const REPLACED_REVISION = '3'.repeat(40);
const BAD_REVISION = '4'.repeat(40);

function active(generation = 1) {
  return {
    v: 1,
    generation,
    subjectRef: 'deployment:abc123def456:runtime',
    ownerFence: { kind: 'containing_task', generation },
    baseline: { bootSequence: 4, bootId: 'boot-4', capturedAt: 100 },
    continuation: {
      when: [{ kind: 'revision_included', revision: TARGET_REVISION, services: ['api', 'web'] }],
      // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
      then: 'Verify the merged behavior in the original thread.',
    },
    autoRenew: false,
    createdAt: 100,
  };
}

async function harness(options = {}) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const task = await taskStore.create({
    kind: 'work',
    threadId: 'thread-deployment',
    title: 'Verify runtime activation',
    ownerCatId: 'codex-sol',
    why: 'The merged change is not in the running deployment yet.',
    createdBy: 'codex-sol',
    userId: 'user-1',
    probe: { kind: 'redis_exists', key: 'legacy-probe-is-orthogonal' },
  });
  const awaitState = active();
  const receipt = createTypedWaitRegistration({
    task,
    active: awaitState,
    invocationId: 'invocation-1',
    source: { kind: 'primary', sourceMessageId: 'message-1' },
  });
  assert.ok(receipt, 'a bounded deployment predicate mints a typed private receipt');
  const installed = await taskStore.replaceDeploymentWaitIfGeneration(task.id, {
    expectedGeneration: null,
    expectedDeploymentWait: task.deploymentWait,
    expectedUpdatedAt: task.updatedAt,
    deploymentWait: { await: awaitState },
    waitRegistration: receipt,
  });
  assert.ok(installed);
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    now: () => 500,
    log: { info() {}, warn() {}, error() {} },
    currentObservation: options.currentObservation ?? (async () => observation()),
  });
  return { taskStore, messageStore, task: installed, lifecycle, receipt };
}

function observation(overrides = {}) {
  return {
    subjectRef: 'deployment:abc123def456:runtime',
    bootId: 'boot-5',
    bootSequence: 5,
    runningRevision: RUNNING_REVISION,
    readyServices: ['api', 'web'],
    observedAt: 500,
    inclusionProof: {
      kind: 'git_ancestry',
      targetRevision: TARGET_REVISION,
      runningRevision: RUNNING_REVISION,
      included: true,
    },
    ...overrides,
  };
}

function freshObservationFor(outcome) {
  return observation({
    inclusionProof: {
      kind: 'git_ancestry',
      targetRevision: outcome.deploymentMatch.targetRevision,
      runningRevision: RUNNING_REVISION,
      included: true,
    },
  });
}

describe('F323 Task-owned deployment wait lifecycle', () => {
  it('installs one persistent work-task generation without using tracking automation or a deployment probe', async () => {
    const h = await harness();
    const snapshot = h.taskStore.getWaitRegistration(h.task.id);

    assert.equal(snapshot.task.kind, 'work');
    assert.equal(snapshot.task.automationState, undefined);
    assert.deepEqual(snapshot.task.probe, { kind: 'redis_exists', key: 'legacy-probe-is-orthogonal' });
    assert.deepEqual(snapshot.task.deploymentWait, { await: active() });
    assert.deepEqual(snapshot.receipt, h.receipt);
    assert.equal(
      isLiveTypedWaitRegistration(
        snapshot,
        {
          invocationId: 'invocation-1',
          userId: 'user-1',
          catId: 'codex-sol',
          threadId: 'thread-deployment',
          sourceMessageId: 'message-1',
        },
        500,
      ),
      true,
      'deployment waits have no forced expiry',
    );
  });

  it('uses generation and task revision as one CAS so concurrent replacements have one winner', async () => {
    const h = await harness();
    const current = await h.taskStore.get(h.task.id);
    const candidates = ['3', '4'].map((digit) => {
      const next = {
        ...active(2),
        continuation: {
          ...active(2).continuation,
          when: [{ kind: 'revision_included', revision: digit.repeat(40), services: ['api'] }],
        },
      };
      return {
        expectedGeneration: 1,
        expectedDeploymentWait: current.deploymentWait,
        expectedUpdatedAt: current.updatedAt,
        deploymentWait: { await: next },
        waitRegistration: createTypedWaitRegistration({
          task: current,
          active: next,
          invocationId: `invocation-${digit}`,
          source: { kind: 'primary', sourceMessageId: `message-${digit}` },
        }),
      };
    });

    const results = await Promise.all(
      candidates.map((candidate) => h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, candidate)),
    );
    assert.equal(results.filter(Boolean).length, 1);
    const stored = await h.taskStore.get(h.task.id);
    assert.equal(stored.deploymentWait.await.generation, 2);
    assert.deepEqual(
      h.taskStore.getWaitRegistration(h.task.id).receipt,
      candidates[results.findIndex(Boolean)].waitRegistration,
    );
  });

  it('matches exact ready evidence once and delivers the original owner a fenced continuation', async () => {
    const h = await harness();

    const result = await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });
    assert.equal(result.kind, 'notified');
    assert.match(result.content, /Verify the merged behavior/);
    assert.match(result.content, /deployment:abc123def456:runtime/);

    const stored = await h.taskStore.get(h.task.id);
    assert.equal(stored.status, 'blocked', 'a deployment match does not complete the business task');
    assert.equal(stored.deploymentWait.await, undefined);
    assert.equal(stored.deploymentWait.waitOutcome.delivery, 'delivered');
    assert.equal(stored.deploymentWait.waitOutcome.domain, 'deployment');
    assert.equal(stored.deploymentWait.waitOutcome.registeredAt, 100, 'the Hub can retain truthful wait duration');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 1);
    const authorityMessage = h.messageStore.getByThread('thread-deployment')[0];
    const retryAuthority = await new WaitContinuationRetryPreflight({ taskStore: h.taskStore }).preflight({
      message: authorityMessage,
      requestingUserId: 'user-1',
      targetCatId: 'codex-sol',
    });
    assert.deepEqual(retryAuthority, { ok: true, kind: 'wait_containing_task' });

    const replay = await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });
    assert.equal(replay.kind, 'deduped');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 1);
  });

  it('keeps unknown or wrong-deployment evidence armed and silent', async () => {
    const h = await harness();
    for (const candidate of [
      observation({ subjectRef: 'deployment:abc123def456:alpha' }),
      observation({ inclusionProof: undefined }),
      observation({ readyServices: ['api'] }),
    ]) {
      const result = await h.lifecycle.observe({ taskId: h.task.id, observation: candidate });
      assert.equal(result.kind, 'state_only');
    }
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.await.generation, 1);
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);
  });

  it('rechecks deployment truth before delivery and recovers the same outcome after readiness returns', async () => {
    let current = observation({ readyServices: ['api'] });
    const h = await harness({ currentObservation: async () => current });

    const stale = await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });
    assert.deepEqual(stale, { kind: 'state_only', reason: 'deployment_evidence_stale' });
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.waitOutcome.delivery, 'pending');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);

    current = observation();
    const recovered = await h.lifecycle.recoverOutcome(h.task.id);
    assert.equal(recovered.kind, 'notified');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 1);
  });

  it('retries the same continuation message until the owner wake is admitted', async () => {
    for (const failedAdmission of ['full', 'throw']) {
      const h = await harness();
      let attempts = 0;
      const lifecycle = new DeploymentWaitLifecycleService({
        taskStore: h.taskStore,
        deliveryDeps: { messageStore: h.messageStore },
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
        currentObservation: async () => observation(),
        wakeOwner: async () => {
          attempts += 1;
          if (attempts === 1) {
            if (failedAdmission === 'throw') throw new Error('wake unavailable');
            return 'full';
          }
          return 'enqueued';
        },
      });
      const first = await lifecycle.observe({ taskId: h.task.id, observation: observation() });
      assert.equal(first.kind, 'state_only');
      assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.waitOutcome.delivery, 'pending');
      const firstMessage = h.messageStore.getByThread('thread-deployment')[0].id;

      const sweep = new DeploymentWaitRecoverySweep(h.taskStore, { observe: async () => observation() }, lifecycle);
      assert.deepEqual(await sweep.run(), { checked: 0, recovered: 1 });
      assert.equal(attempts, 2);
      assert.equal(h.messageStore.getByThread('thread-deployment').length, 1);
      assert.equal(h.messageStore.getByThread('thread-deployment')[0].id, firstMessage);
      assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.waitOutcome.delivery, 'delivered');
    }
  });

  it('can cancel a matched outcome whose delivery is still pending', async () => {
    const h = await harness({ currentObservation: async () => observation({ readyServices: ['api'] }) });
    await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });

    const cancelled = await h.lifecycle.cancel(h.task.id, { kind: 'user', userId: 'user-1' });
    assert.deepEqual(cancelled, { kind: 'state_only', reason: 'user_cancel' });
    const stored = await h.taskStore.get(h.task.id);
    assert.equal(stored.deploymentWait.waitOutcome.reason, 'user_cancel');
    assert.equal(stored.deploymentWait.waitOutcome.delivery, 'not_applicable');
    assert.equal((await h.lifecycle.recoverOutcome(h.task.id)).kind, 'state_only');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);
  });

  it('counts a pending outcome as recovered only after fresh evidence permits delivery', async () => {
    let current = observation({ readyServices: ['api'] });
    const h = await harness({ currentObservation: async () => current });
    await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });
    const provider = { observe: async () => current };
    const sweep = new DeploymentWaitRecoverySweep(h.taskStore, provider, h.lifecycle);

    assert.deepEqual(await sweep.run(), { checked: 0, recovered: 0 });
    current = observation();
    assert.deepEqual(await sweep.run(), { checked: 0, recovered: 1 });
  });

  it('terminalizes the wait without completing the business Task before its owner does', async () => {
    const h = await harness();
    const terminated = await h.lifecycle.taskCompleted(h.task.id);
    assert.deepEqual(terminated, { kind: 'state_only', reason: 'subject_terminal' });
    const stored = await h.taskStore.get(h.task.id);
    assert.equal(stored.status, 'doing');
    assert.equal(stored.deploymentWait.waitOutcome.reason, 'subject_terminal');
  });

  it('cancels the exact generation without completing or waking the work Task', async () => {
    const h = await harness();
    const result = await h.lifecycle.cancel(h.task.id, { kind: 'user', userId: 'user-1' });
    assert.deepEqual(result, { kind: 'state_only', reason: 'user_cancel' });
    const stored = await h.taskStore.get(h.task.id);
    assert.equal(stored.status, 'doing');
    assert.equal(stored.deploymentWait.await, undefined);
    assert.equal(stored.deploymentWait.waitOutcome.reason, 'user_cancel');
    assert.equal(stored.deploymentWait.waitOutcome.delivery, 'not_applicable');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);
  });

  it('does not retarget a stranded outcome after the Task owner changes', async () => {
    const h = await harness();
    const append = h.messageStore.append.bind(h.messageStore);
    let fail = true;
    h.messageStore.append = (input) => {
      if (fail) {
        fail = false;
        throw new Error('message store unavailable');
      }
      return append(input);
    };
    await assert.rejects(
      h.lifecycle.observe({ taskId: h.task.id, observation: observation() }),
      /message store unavailable/,
    );
    const stranded = await h.taskStore.get(h.task.id);
    assert.equal(stranded.deploymentWait.waitOutcome.delivery, 'pending');
    h.taskStore.update(h.task.id, { ownerCatId: 'opus' });

    const recovered = await h.lifecycle.recoverOutcome(h.task.id);
    assert.deepEqual(recovered, { kind: 'state_only', reason: 'owner_changed' });
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);
  });

  it('atomically ends active and pending waits when a generic Task update completes or transfers custody', async () => {
    for (const [patch, pending] of [
      [{ status: 'done' }, false],
      [{ ownerCatId: 'opus' }, false],
      [{ status: 'done' }, true],
      [{ ownerCatId: 'opus' }, true],
    ]) {
      const h = await harness({ currentObservation: async () => observation({ readyServices: ['api'] }) });
      if (pending) {
        const matched = await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });
        assert.equal(matched.reason, 'deployment_evidence_stale');
      }
      const updated = await h.taskStore.update(h.task.id, patch);
      const expectedReason = patch.status === 'done' ? 'subject_terminal' : 'owner_changed';
      assert.equal(updated.deploymentWait.await, undefined);
      assert.equal(updated.deploymentWait.waitOutcome.reason, expectedReason);
      assert.equal(updated.deploymentWait.waitOutcome.delivery, 'not_applicable');
      await h.taskStore.update(h.task.id, { status: 'doing' });
      const sweep = new DeploymentWaitRecoverySweep(h.taskStore, { observe: async () => observation() }, h.lifecycle);
      assert.deepEqual(await sweep.run(), { checked: 0, recovered: 0 });
      assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);
    }
  });

  it('ends a subject-owned wait when the canonical Task is upserted to another cat', async () => {
    const taskStore = new TaskStore();
    const input = {
      kind: 'work',
      subjectKey: 'f323:acceptance',
      threadId: 'thread-deployment',
      title: 'Verify deployment',
      ownerCatId: 'codex-sol',
      why: 'Wait for activation',
      createdBy: 'codex-sol',
      userId: 'user-1',
    };
    const task = await taskStore.create(input);
    assert.ok(
      await taskStore.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: null,
        expectedDeploymentWait: task.deploymentWait,
        expectedUpdatedAt: task.updatedAt,
        deploymentWait: { await: active() },
      }),
    );
    const transferred = await taskStore.upsertBySubject({ ...input, ownerCatId: 'kimi' });
    assert.equal(transferred.deploymentWait.await, undefined);
    assert.equal(transferred.deploymentWait.waitOutcome.reason, 'owner_changed');
  });

  it('converges two racing workers onto exactly one delivered continuation message', async () => {
    const h = await harness();
    const secondWorker = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
      currentObservation: async () => observation(),
    });

    const results = await Promise.all([
      h.lifecycle.observe({ taskId: h.task.id, observation: observation() }),
      secondWorker.observe({ taskId: h.task.id, observation: observation() }),
    ]);
    assert.equal(results.filter((result) => result.kind === 'notified').length, 1);
    assert.ok(
      results.every(
        (result) => result.kind === 'notified' || result.kind === 'state_only' || result.kind === 'deduped',
      ),
    );
    assert.equal(
      h.messageStore.getByThread('thread-deployment').length,
      1,
      'the deployment-wait idempotency key converges the duplicate delivery',
    );
    const stored = await h.taskStore.get(h.task.id);
    assert.equal(stored.deploymentWait.waitOutcome.delivery, 'delivered');
  });

  it('refuses delivery as authority_stale when the custody receipt is gone', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const task = await taskStore.create({
      kind: 'work',
      threadId: 'thread-deployment',
      title: 'Verify runtime activation',
      ownerCatId: 'codex-sol',
      why: 'The merged change is not in the running deployment yet.',
      createdBy: 'codex-sol',
      userId: 'user-1',
    });
    const pendingOutcome = {
      v: 1,
      domain: 'deployment',
      outcomeId: 'wait:deployment:abc123def456:runtime:g1:matched',
      generation: 1,
      subjectRef: 'deployment:abc123def456:runtime',
      ownerFence: { kind: 'containing_task', generation: 1 },
      reason: 'matched',
      at: 500,
      registeredAt: 100,
      delivery: 'pending',
      deploymentMatch: {
        kind: 'revision_included',
        services: ['api', 'web'],
        targetRevision: TARGET_REVISION,
        bootId: 'boot-5',
        bootSequence: 5,
        runningRevision: RUNNING_REVISION,
        observedAt: 500,
        proofKind: 'git_ancestry',
      },
      nextStep: 'Verify the merged behavior in the original thread.',
      actor: { kind: 'system' },
    };
    const installed = await taskStore.replaceDeploymentWaitIfGeneration(task.id, {
      expectedGeneration: null,
      expectedDeploymentWait: task.deploymentWait,
      expectedUpdatedAt: task.updatedAt,
      deploymentWait: { waitOutcome: pendingOutcome },
      status: 'blocked',
    });
    assert.ok(installed);
    assert.equal(taskStore.getWaitRegistration(task.id).receipt, null);

    const warnings = [];
    const lifecycle = new DeploymentWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      now: () => 500,
      log: { info() {}, warn: (...args) => warnings.push(args), error() {} },
      currentObservation: async () => observation(),
    });
    const result = await lifecycle.recoverOutcome(task.id);
    assert.deepEqual(result, { kind: 'state_only', reason: 'authority_stale' });
    assert.equal(warnings.length, 1, 'the lost receipt is logged once');
    assert.equal(messageStore.getByThread('thread-deployment').length, 0);
    const stored = await taskStore.get(task.id);
    assert.equal(
      stored.deploymentWait.waitOutcome.delivery,
      'pending',
      'a lost receipt never retargets or fabricates the delivery',
    );
  });

  it('does not revive a replaced generation with its stale predicate evidence', async () => {
    const h = await harness({ currentObservation: async (outcome) => freshObservationFor(outcome) });
    const current = await h.taskStore.get(h.task.id);
    const replaced = {
      ...active(2),
      continuation: {
        ...active(2).continuation,
        when: [{ kind: 'revision_included', revision: REPLACED_REVISION, services: ['api', 'web'] }],
      },
    };
    const installed = await h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
      expectedGeneration: 1,
      expectedDeploymentWait: current.deploymentWait,
      expectedUpdatedAt: current.updatedAt,
      deploymentWait: { await: replaced },
      waitRegistration: createTypedWaitRegistration({
        task: current,
        active: replaced,
        invocationId: 'invocation-2',
        source: { kind: 'primary', sourceMessageId: 'message-2' },
      }),
    });
    assert.ok(installed);

    const stale = await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });
    assert.equal(stale.kind, 'state_only', 'gen1 evidence must not match the gen2 predicate');
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.await.generation, 2);
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);

    const own = await h.lifecycle.observe({
      taskId: h.task.id,
      observation: observation({
        inclusionProof: {
          kind: 'git_ancestry',
          targetRevision: REPLACED_REVISION,
          runningRevision: RUNNING_REVISION,
          included: true,
        },
      }),
    });
    assert.equal(own.kind, 'notified', 'only gen2 evidence triggers the gen2 continuation');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 1);
  });

  it('publishes the wake with a waitContinuationCarrier source meta and no line-start mention routing', async () => {
    const h = await harness();
    const result = await h.lifecycle.observe({ taskId: h.task.id, observation: observation() });
    assert.equal(result.kind, 'notified');

    const message = h.messageStore.getByThread('thread-deployment')[0];
    assert.equal(message.threadId, 'thread-deployment');
    assert.equal(message.userId, 'user-1');
    assert.equal(message.source.connector, 'deployment-wait');
    assert.deepEqual(message.source.meta.waitContinuationCarrier, {
      v: 1,
      waitId: h.task.id,
      outcomeId: result.outcome.outcomeId,
      ownerFence: { kind: 'containing_task', generation: 1 },
    });
    assert.ok(!/^@/m.test(result.content), 'the continuation carries no line-start @ routing');
  });

  it('sweep skips waits whose observation is unavailable', async () => {
    const h = await harness();
    const sweep = new DeploymentWaitRecoverySweep(h.taskStore, { observe: async () => null }, h.lifecycle);

    assert.deepEqual(await sweep.run(), { checked: 0, recovered: 0 });
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.await.generation, 1);
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);
  });

  it('periodic compensation revisits an initially unavailable deployment within the same boot', async () => {
    const h = await harness();
    let available = false;
    const sweep = new DeploymentWaitRecoverySweep(
      h.taskStore,
      { observe: async () => (available ? observation() : null) },
      h.lifecycle,
    );
    sweep.startPeriodic(20);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.await.generation, 1);
      available = true;
      const deadline = Date.now() + 500;
      while ((await h.taskStore.get(h.task.id)).deploymentWait.waitOutcome?.delivery !== 'delivered') {
        assert.ok(Date.now() < deadline, 'the periodic sweep must eventually consume the ready evidence');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(h.messageStore.getByThread('thread-deployment').length, 1);
    } finally {
      sweep.stopPeriodic();
    }
  });

  it('sweep recovers observable waits and isolates per-task failures', async () => {
    const h = await harness({ currentObservation: async (outcome) => freshObservationFor(outcome) });
    const bad = await h.taskStore.create({
      kind: 'work',
      threadId: 'thread-deployment-bad',
      title: 'Wait on a deployment whose provider fails',
      ownerCatId: 'codex-sol',
      why: 'Its observation provider throws.',
      createdBy: 'codex-sol',
      userId: 'user-1',
    });
    const badAwait = {
      ...active(),
      continuation: {
        ...active().continuation,
        when: [{ kind: 'revision_included', revision: BAD_REVISION, services: ['api'] }],
      },
    };
    const installedBad = await h.taskStore.replaceDeploymentWaitIfGeneration(bad.id, {
      expectedGeneration: null,
      expectedDeploymentWait: bad.deploymentWait,
      expectedUpdatedAt: bad.updatedAt,
      deploymentWait: { await: badAwait },
      waitRegistration: createTypedWaitRegistration({
        task: bad,
        active: badAwait,
        invocationId: 'invocation-bad',
        source: { kind: 'primary', sourceMessageId: 'message-bad' },
      }),
    });
    assert.ok(installedBad);

    const warnings = [];
    const provider = {
      observe: async ({ targetRevision }) => {
        if (targetRevision === BAD_REVISION) throw new Error('provider exploded');
        return observation({
          inclusionProof: {
            kind: 'git_ancestry',
            targetRevision,
            runningRevision: RUNNING_REVISION,
            included: true,
          },
        });
      },
    };
    const sweep = new DeploymentWaitRecoverySweep(h.taskStore, provider, h.lifecycle, {
      warn: (...args) => warnings.push(args),
    });

    assert.deepEqual(await sweep.run(), { checked: 1, recovered: 1 });
    assert.equal(warnings.length, 1, 'the failing task is counted once without stopping the sweep');
    assert.equal(warnings[0][0].taskId, bad.id);
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 1);
    assert.equal(
      (await h.taskStore.get(bad.id)).deploymentWait.await.generation,
      1,
      'the failed task keeps its active wait for the next sweep',
    );
  });

  it('keeps a live registration turn as the sole consumer, then recovers its claim after that turn fails', async () => {
    const h = await harness();
    const current = await h.taskStore.get(h.task.id);
    assert.ok(
      await h.taskStore.replaceDeploymentWaitIfGeneration(current.id, {
        expectedGeneration: 1,
        expectedDeploymentWait: current.deploymentWait,
        deploymentWait: {
          await: current.deploymentWait.await,
          currentExecutionClaim: { invocationId: 'invocation-1', generation: 1, bootId: 'boot-5' },
        },
      }),
    );
    let activeInvocation = true;
    const lifecycle = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      currentObservation: async () => observation(),
      turnExecutionStore: { get: async () => ({ status: activeInvocation ? 'running' : 'failed' }) },
    });
    assert.deepEqual(await lifecycle.observe({ taskId: h.task.id, observation: observation() }), {
      kind: 'state_only',
      reason: 'current_execution_claimed',
    });
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 0);
    activeInvocation = false;
    assert.equal((await lifecycle.observe({ taskId: h.task.id, observation: observation() })).kind, 'notified');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 1);
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.currentExecutionClaim, undefined);
  });

  it('re-arms an immediate current-turn outcome after a failed invocation on a later boot', async () => {
    const h = await harness();
    const before = await h.taskStore.get(h.task.id);
    assert.ok(
      await h.taskStore.replaceDeploymentWaitIfGeneration(before.id, {
        expectedGeneration: 1,
        expectedDeploymentWait: before.deploymentWait,
        deploymentWait: {
          await: before.deploymentWait.await,
          currentExecutionClaim: { invocationId: 'invocation-1', generation: 1, bootId: 'boot-old' },
        },
      }),
    );
    const currentTurn = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      currentObservation: async () => observation(),
    });
    assert.equal(
      (
        await currentTurn.observe({
          taskId: h.task.id,
          observation: observation(),
          currentInvocationId: 'invocation-1',
          wakeOwner: false,
        })
      ).kind,
      'notified',
    );
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.waitOutcome.delivery, 'delivered');
    const recovery = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      bootId: 'boot-new',
      turnExecutionStore: { get: async () => ({ status: 'running' }) },
      currentObservation: async () => observation(),
      wakeOwner: async () => 'enqueued',
    });
    assert.equal((await recovery.recoverOutcome(h.task.id)).kind, 'notified');
    assert.equal(h.messageStore.getByThread('thread-deployment').length, 1, 'recovery reuses the original message id');
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.currentExecutionClaim, undefined);
  });

  it('settles a successful current-turn consumer without another wake', async () => {
    const h = await harness();
    const before = await h.taskStore.get(h.task.id);
    assert.ok(
      await h.taskStore.replaceDeploymentWaitIfGeneration(before.id, {
        expectedGeneration: 1,
        expectedDeploymentWait: before.deploymentWait,
        deploymentWait: {
          await: before.deploymentWait.await,
          currentExecutionClaim: { invocationId: 'invocation-1', generation: 1, bootId: 'boot-5' },
        },
      }),
    );
    const currentTurn = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      currentObservation: async () => observation(),
    });
    assert.equal(
      (
        await currentTurn.observe({
          taskId: h.task.id,
          observation: observation(),
          currentInvocationId: 'invocation-1',
          wakeOwner: false,
        })
      ).kind,
      'notified',
    );
    const recovery = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      bootId: 'boot-5',
      turnExecutionStore: { get: async () => ({ status: 'succeeded' }) },
      currentObservation: async () => observation(),
      wakeOwner: async () => {
        throw new Error('must not wake');
      },
    });
    assert.equal((await recovery.recoverOutcome(h.task.id)).kind, 'state_only');
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.waitOutcome.delivery, 'delivered');
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.currentExecutionClaim, undefined);
  });

  it('uses the callback child execution, not its parent, to settle an immediate-match claim', async () => {
    const h = await harness();
    const parentStore = new InvocationRecordStore();
    const parent = await parentStore.create({
      threadId: h.task.threadId,
      userId: h.task.userId,
      targetCats: [h.task.ownerCatId],
      intent: 'execute',
      idempotencyKey: 'f323-current-turn-parent',
      actionLeaseCarrier: { kind: 'none' },
    });
    await parentStore.update(parent.invocationId, { status: 'running' });
    const turnExecutionStore = new InMemoryTurnExecutionStore();
    const registry = new InvocationRegistry({ turnExecutionStore });
    const child = await registry.create(h.task.userId, h.task.ownerCatId, h.task.threadId, parent.invocationId);
    await turnExecutionStore.createRunning({
      invocationId: child.invocationId,
      parentInvocationId: parent.invocationId,
      threadId: h.task.threadId,
      userId: h.task.userId,
      catId: h.task.ownerCatId,
      executionKind: 'ordinary',
      startedAt: 500,
    });
    const before = await h.taskStore.get(h.task.id);
    assert.ok(
      await h.taskStore.replaceDeploymentWaitIfGeneration(before.id, {
        expectedGeneration: 1,
        expectedDeploymentWait: before.deploymentWait,
        deploymentWait: {
          await: before.deploymentWait.await,
          currentExecutionClaim: { invocationId: child.invocationId, generation: 1, bootId: 'boot-5' },
        },
      }),
    );
    const currentTurn = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      currentObservation: async () => observation(),
    });
    assert.equal(
      (
        await currentTurn.observe({
          taskId: h.task.id,
          observation: observation(),
          currentInvocationId: child.invocationId,
          wakeOwner: false,
        })
      ).kind,
      'notified',
    );
    let wakes = 0;
    const recovery = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      bootId: 'boot-5',
      turnExecutionStore,
      currentObservation: async () => observation(),
      wakeOwner: async () => {
        wakes += 1;
        return 'enqueued';
      },
    });
    assert.equal((await recovery.recoverOutcome(h.task.id)).reason, 'current_execution_claimed');
    assert.equal(wakes, 0);
    assert.equal(
      (await h.taskStore.get(h.task.id)).deploymentWait.currentExecutionClaim.invocationId,
      child.invocationId,
    );
    assert.equal(await parentStore.get(child.invocationId), null, 'the parent store has no child key');

    await turnExecutionStore.transitionTerminal(child.invocationId, { status: 'succeeded', endedAt: 501 });
    assert.equal((await recovery.recoverOutcome(h.task.id)).kind, 'state_only');
    assert.equal(wakes, 0, 'a successful child already consumed the current turn');
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.currentExecutionClaim, undefined);
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.waitOutcome.delivery, 'delivered');

    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /bootId: runtimeDeploymentContext\.bootId,\s*turnExecutionStore,/);
  });

  it('keeps an unresolved same-boot child claim until a later boot can recover it', async () => {
    const h = await harness();
    const before = await h.taskStore.get(h.task.id);
    assert.ok(
      await h.taskStore.replaceDeploymentWaitIfGeneration(before.id, {
        expectedGeneration: 1,
        expectedDeploymentWait: before.deploymentWait,
        deploymentWait: {
          await: before.deploymentWait.await,
          currentExecutionClaim: { invocationId: 'child-without-record', generation: 1, bootId: 'boot-5' },
        },
      }),
    );
    const currentTurn = new DeploymentWaitLifecycleService({
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      currentObservation: async () => observation(),
    });
    assert.equal(
      (
        await currentTurn.observe({
          taskId: h.task.id,
          observation: observation(),
          currentInvocationId: 'child-without-record',
          wakeOwner: false,
        })
      ).kind,
      'notified',
    );
    let wakes = 0;
    const options = {
      taskStore: h.taskStore,
      deliveryDeps: { messageStore: h.messageStore },
      log: { info() {}, warn() {}, error() {} },
      turnExecutionStore: { get: async () => null },
      currentObservation: async () => observation(),
      wakeOwner: async () => {
        wakes += 1;
        return 'enqueued';
      },
    };
    const sameBoot = new DeploymentWaitLifecycleService({ ...options, bootId: 'boot-5' });
    assert.equal((await sameBoot.recoverOutcome(h.task.id)).reason, 'current_execution_claimed');
    assert.equal(wakes, 0);
    const nextBoot = new DeploymentWaitLifecycleService({ ...options, bootId: 'boot-6' });
    assert.equal((await nextBoot.recoverOutcome(h.task.id)).kind, 'notified');
    assert.equal(wakes, 1);
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.currentExecutionClaim, undefined);
  });

  it('rechecks queued deployment continuation against owner, Task terminal state, and live proof', async () => {
    const h = await harness();
    assert.equal((await h.lifecycle.observe({ taskId: h.task.id, observation: observation() })).kind, 'notified');
    const message = h.messageStore.getByThread('thread-deployment')[0];
    let ready = true;
    const guard = new DeploymentWaitStartGuard({
      taskStore: h.taskStore,
      messageStore: h.messageStore,
      observationProvider: { observe: async () => (ready ? observation() : observation({ readyServices: [] })) },
    });
    const identity = { messageId: message.id, threadId: h.task.threadId, userId: 'user-1', catId: 'codex-sol' };
    assert.equal(await guard.canStart(identity), true);
    ready = false;
    assert.equal(await guard.canStart(identity), false, 'an old ready ledger fact cannot start queued work');
    assert.equal((await h.taskStore.get(h.task.id)).deploymentWait.waitOutcome.delivery, 'pending');
    ready = true;
    assert.equal(
      (await h.lifecycle.recoverOutcome(h.task.id)).messageId,
      message.id,
      'recovery keeps the same message',
    );
    h.taskStore.update(h.task.id, { status: 'done' });
    assert.equal(await guard.canStart(identity), false, 'completed work revokes an admitted continuation');
    const githubMessage = h.messageStore.append({
      threadId: h.task.threadId,
      userId: 'user-1',
      catId: null,
      content: 'GitHub review ready',
      timestamp: 600,
      source: { connector: 'github-wait', label: 'GitHub Wait', icon: 'github' },
    });
    assert.equal(await guard.canStart({ ...identity, messageId: githubMessage.id, expectedWaitCarrier: true }), true);
    assert.equal(await guard.canStart({ ...identity, messageId: 'missing-legacy-connector' }), true);
    assert.equal(
      await guard.canStart({ ...identity, messageId: 'missing-deployment', expectedDeploymentWait: true }),
      false,
    );
  });
});
