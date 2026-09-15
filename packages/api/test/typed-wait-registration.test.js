import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import {
  createTypedWaitRegistration,
  isLiveTypedWaitRegistration,
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
      s.task.automationState.await.subjectRef = 'pr:owner/repo#2';
    },
  ],
  [
    'generation',
    (s) => {
      s.task.automationState.await.generation = 2;
    },
  ],
  [
    'owner fence',
    (s) => {
      s.task.automationState.await.ownerFence.generation = 2;
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
      s.task.automationState.waitOutcome = { generation: 1, reason: 'matched' };
    },
  ],
  [
    'expiry',
    (s) => {
      s.task.automationState.await.expiresAt = 1;
    },
  ],
  [
    'predicate',
    (s) => {
      s.task.automationState.await.continuation.when = [{ kind: 'pr_head_changed' }];
    },
  ],
  [
    'baseline',
    (s) => {
      s.task.automationState.await.baseline.headSha = 'other-head';
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
}

test('unknown predicates and unanchored review cannot mint a generic receipt', async () => {
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

test('predicate identity survives JSON storage omitting optional undefined baseline fields', async () => {
  const h = await fixture();
  const active = { ...h.active, baseline: { ...h.active.baseline, review: undefined } };
  const receipt = createTypedWaitRegistration({
    task: h.task,
    active,
    invocationId: 'child-1',
    source: h.receipt.source,
  });
  const task = { ...h.task, automationState: { await: JSON.parse(JSON.stringify(active)) } };
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
  h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
    expectedGeneration: 1,
    automationState: { await: active },
  });
  assert.equal(h.taskStore.getWaitRegistration(h.task.id).receipt, null);
  h.taskStore.delete(h.task.id);
  assert.equal(h.taskStore.getWaitRegistration(h.task.id), null);
});
