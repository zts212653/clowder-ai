import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import {
  createTypedWaitRegistration,
  isLiveTypedWaitRegistration,
  parseTypedWaitRegistration,
} from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { createTypedWaitCustodyFixture } from './helpers/typed-wait-custody-fixture.js';

const identity = { invocationId: 'child-1', userId: 'user-1', catId: 'opus', threadId: 'thread-wait' };
async function fixture() {
  const h = await createTypedWaitCustodyFixture();
  return { ...h, identity: { ...identity, sourceMessageId: h.message.id, holdTaskId: 'hold-1' } };
}

for (const [name, mutate] of [
  [
    'owner',
    (s) => {
      s.task.ownerCatId = 'other';
    },
  ],
  [
    'user',
    (s) => {
      s.task.userId = 'other';
    },
  ],
  [
    'thread',
    (s) => {
      s.task.threadId = 'other';
    },
  ],
  [
    'subject',
    (s) => {
      s.task.deploymentWait.await.subjectRef = 'deployment:another:runtime';
    },
  ],
  [
    'generation',
    (s) => {
      s.task.deploymentWait.await.generation = 2;
    },
  ],
  [
    'owner fence',
    (s) => {
      s.task.deploymentWait.await.ownerFence.generation = 2;
    },
  ],
  [
    'done',
    (s) => {
      s.task.status = 'done';
    },
  ],
  [
    'matched',
    (s) => {
      s.task.deploymentWait.waitOutcome = { generation: 1, reason: 'matched' };
    },
  ],
  [
    'expiry',
    (s) => {
      s.task.deploymentWait.await.expiresAt = 1;
    },
  ],
  [
    'predicate',
    (s) => {
      s.task.deploymentWait.await.continuation.when = [{ kind: 'new_ready_boot', services: ['web'] }];
    },
  ],
  [
    'baseline',
    (s) => {
      s.task.deploymentWait.await.baseline.bootId = 'other-boot';
    },
  ],
  [
    'invocation',
    (s) => {
      s.receipt.invocationId = 'other';
    },
  ],
  [
    'source',
    (s) => {
      s.receipt.source.sourceMessageId = 'other';
    },
  ],
  [
    'hold task',
    (s) => {
      s.receipt.source.holdTaskId = 'other';
    },
  ],
  [
    'private proof absent',
    (s) => {
      s.receipt = null;
    },
  ],
]) {
  test(`registration rejects ${name} drift`, async () => {
    const h = await fixture();
    const snapshot = h.taskStore.getWaitRegistration(h.task.id);
    mutate(snapshot);
    assert.equal(isLiveTypedWaitRegistration(snapshot, h.identity, Date.now()), false);
  });

  test(`a registration without a deadline rejects ${name} drift`, async () => {
    const h = await fixture();
    const { expiresAt: _deadline, ...active } = h.active;
    const receipt = createTypedWaitRegistration({
      task: h.task,
      active,
      invocationId: 'child-1',
      source: h.receipt.source,
    });
    await h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
      expectedGeneration: 1,
      expectedDeploymentWait: (await h.taskStore.get(h.task.id)).deploymentWait,
      deploymentWait: { await: active },
      waitRegistration: receipt,
    });
    const snapshot = await h.taskStore.getWaitRegistration(h.task.id);
    assert.equal(isLiveTypedWaitRegistration(snapshot, h.identity, Date.now()), true, 'live before the drift');
    mutate(snapshot);
    assert.equal(isLiveTypedWaitRegistration(snapshot, h.identity, Date.now()), false);
  });
}

test('unsupported plugin-specific predicates cannot mint a Host deployment receipt', async () => {
  const h = await fixture();
  for (const kind of ['unknown', 'pr_review_result_available']) {
    const active = structuredClone(h.active);
    active.continuation.when = [{ kind }];
    assert.equal(
      createTypedWaitRegistration({ task: h.task, active, invocationId: 'child-1', source: h.receipt.source }),
      null,
    );
  }
});

test('historical GitHub receipts remain readable but never authorize a live continuation', async () => {
  const h = await fixture();
  const legacyTask = {
    ...h.task,
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#99',
    deploymentWait: undefined,
    automationState: {
      await: {
        ...h.active,
        subjectRef: 'pr:owner/repo#99',
        baseline: { capturedAt: h.active.createdAt, headSha: 'a'.repeat(40) },
        // biome-ignore lint/suspicious/noThenProperty: persisted legacy schema uses a string field, not a Promise thenable.
        continuation: { when: [{ kind: 'pr_ci_terminal' }], then: 'Historical continuation' },
      },
    },
  };
  const receipt = parseTypedWaitRegistration({
    ...h.receipt,
    taskKind: 'pr_tracking',
    subjectRef: legacyTask.subjectKey,
    proofKind: 'typed_predicates',
  });
  assert.ok(receipt, 'historical persisted data can still be decoded');
  assert.equal(isLiveTypedWaitRegistration({ task: legacyTask, receipt }, h.identity, Date.now()), false);
  assert.equal(
    createTypedWaitRegistration({
      task: legacyTask,
      active: legacyTask.automationState.await,
      invocationId: 'child-1',
      source: h.registrationSource,
    }),
    null,
  );
});

test('a wait without a deadline mints a receipt that stays live until the wait itself moves', async () => {
  const h = await fixture();
  const { expiresAt: _deadline, ...active } = h.active;
  const receipt = createTypedWaitRegistration({
    task: h.task,
    active,
    invocationId: 'child-1',
    source: h.receipt.source,
  });
  assert.ok(receipt, 'no deadline is the normal registration, not a reason to withhold the proof');
  assert.equal(receipt.expiresAt, undefined);
  const task = { ...h.task, deploymentWait: { await: JSON.parse(JSON.stringify(active)) } };
  assert.equal(isLiveTypedWaitRegistration({ task, receipt }, h.identity, Number.MAX_SAFE_INTEGER), true);
  const moved = structuredClone(task);
  moved.deploymentWait.await.generation = 2;
  assert.equal(isLiveTypedWaitRegistration({ task: moved, receipt }, h.identity, Date.now()), false);
  const deadlined = structuredClone(task);
  deadlined.deploymentWait.await.expiresAt = Date.now() + 60000;
  assert.equal(
    isLiveTypedWaitRegistration({ task: deadlined, receipt }, h.identity, Date.now()),
    false,
    'a deadline the receipt did not see is drift',
  );
});

test('predicate identity survives JSON storage omitting optional undefined baseline fields', async () => {
  const h = await fixture();
  const active = { ...h.active, baseline: { ...h.active.baseline, optional: undefined } };
  const receipt = createTypedWaitRegistration({
    task: h.task,
    active,
    invocationId: 'child-1',
    source: h.receipt.source,
  });
  const task = { ...h.task, deploymentWait: { await: JSON.parse(JSON.stringify(active)) } };
  assert.equal(isLiveTypedWaitRegistration({ task, receipt }, h.identity, Date.now()), true);
});

test('query errors and missing identity cannot fall back to a tracker scan', async () => {
  const h = await fixture();
  for (const method of ['listByThread', 'getWaitRegistration']) {
    const broken = {
      listByThread: h.taskStore.listByThread.bind(h.taskStore),
      getWaitRegistration: h.taskStore.getWaitRegistration.bind(h.taskStore),
      [method]: async () => {
        throw new Error('unavailable');
      },
    };
    assert.deepEqual(await resolveTypedWaitContinuation({ taskStore: broken, ...h.identity }), {
      kind: 'reject',
      reason: 'query_failed',
    });
  }
  assert.equal(
    (await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity, invocationId: undefined })).kind,
    'reject',
  );
  assert.equal((await resolveTypedWaitContinuation({ ...h.identity })).kind, 'reject');
});

test('private memory receipt is cloned, discarded on a new unproven generation, and removed with its Task', async () => {
  const h = await fixture();
  h.taskStore.getWaitRegistration(h.task.id).receipt.invocationId = 'mutated';
  assert.equal(h.taskStore.getWaitRegistration(h.task.id).receipt.invocationId, 'child-1');
  const active = { ...h.active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } };
  h.taskStore.replaceDeploymentWaitIfGeneration(h.task.id, {
    expectedGeneration: 1,
    expectedDeploymentWait: (await h.taskStore.get(h.task.id)).deploymentWait,
    deploymentWait: { await: active },
  });
  assert.equal(h.taskStore.getWaitRegistration(h.task.id).receipt, null);
  h.taskStore.delete(h.task.id);
  assert.equal(h.taskStore.getWaitRegistration(h.task.id), null);
});
