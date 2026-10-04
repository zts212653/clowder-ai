import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import { developmentTaskSnapshot } from '../../src/domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';

const scope = {
  featureRef: 'feature:F310',
  phaseKey: 'B',
  workUnitRef: 'feature-phase:F310:B',
  acceptedSourceRef: 'file:docs/features/F310-growing-real-delegation.md',
  acceptedRevision: 'a'.repeat(40),
};
const actor = { userId: 'user-a', threadId: 'thread-a', catId: 'codex-sol' };
const contract = {
  revision: 1,
  admission: {
    basis: 'explicit_entrustment',
    sourceRefs: ['message:first'],
    idempotencyKey: 'first',
    receiptRef: 'task:receipt:first',
    admittedAt: 1,
  },
  intendedOutcome: 'Accepted Phase B',
  time: {},
  artifactRefs: [],
  closure: { state: 'open', condition: 'Result verified', expectedSignal: 'verified', evidenceRefs: [] },
};
const admit = {
  action: 'admit',
  actor,
  scope,
  sourceRef: 'message:first',
  sourceRevision: `sha256:${'a'.repeat(64)}`,
  idempotencyKey: 'first',
  title: 'Accepted Phase B',
  why: 'Human authorized it',
  contract,
};

test('different source explicitly resumes the same scope and preserves original admission', async () => {
  const store = new TaskStore();
  const first = await store.transitionDevelopmentWork(admit);
  assert.equal(first.result, 'admitted');
  const resumed = await store.transitionDevelopmentWork({
    action: 'resume',
    actor,
    scope,
    sourceRef: 'message:continue',
    sourceRevision: `sha256:${'b'.repeat(64)}`,
    idempotencyKey: 'continue',
    taskId: first.task.id,
    expectedRevision: 1,
  });
  assert.equal(resumed.result, 'resumed');
  assert.equal(resumed.task.id, first.task.id);
  assert.deepEqual(resumed.task.entrustedWork.admission, first.task.entrustedWork.admission);
  assert.equal(store.listByThread(actor.threadId).length, 1);
  const replay = await store.transitionDevelopmentWork({
    action: 'resume',
    actor,
    scope,
    sourceRef: 'message:continue',
    sourceRevision: `sha256:${'b'.repeat(64)}`,
    idempotencyKey: 'continue',
    taskId: first.task.id,
    expectedRevision: 1,
  });
  assert.equal(replay.receiptRef, resumed.receiptRef);
  assert.equal(replay.task.entrustedWork.revision, resumed.task.entrustedWork.revision);
  const sourceQuery = {
    actor,
    taskId: first.task.id,
    sourceRef: 'message:continue',
    sourceRevision: `sha256:${'b'.repeat(64)}`,
  };
  assert.equal(store.hasDevelopmentSource(sourceQuery), true);
  assert.equal(store.hasDevelopmentSource({ ...sourceQuery, sourceRef: 'message:unrelated' }), false);
  assert.equal(store.hasDevelopmentSource({ ...sourceQuery, sourceRevision: `sha256:${'c'.repeat(64)}` }), false);
  for (const foreign of [
    { ...actor, userId: 'other' },
    { ...actor, threadId: 'elsewhere' },
    { ...actor, catId: 'opus' },
  ]) {
    assert.equal(store.hasDevelopmentSource({ ...sourceQuery, actor: foreign }), false);
  }
});

test('same-user cross-thread collision discloses no Task and creates nothing', async () => {
  const store = new TaskStore();
  await store.transitionDevelopmentWork(admit);
  assert.deepEqual(await store.transitionDevelopmentWork({ ...admit, actor: { ...actor, threadId: 'elsewhere' } }), {
    result: 'scope_unavailable_here',
  });
  assert.equal(store.listByThread('elsewhere').length, 0);
});

test('different users and distinct stable work units never merge', async () => {
  const store = new TaskStore();
  const first = await store.transitionDevelopmentWork(admit);
  const otherUser = await store.transitionDevelopmentWork({ ...admit, actor: { ...actor, userId: 'user-b' } });
  const child = await store.transitionDevelopmentWork({
    ...admit,
    idempotencyKey: 'child',
    scope: { ...scope, workUnitRef: 'file:docs/plans/accepted-plan.md#child' },
  });
  assert.equal(otherUser.result, 'admitted');
  assert.equal(child.result, 'admitted');
  assert.notEqual(otherUser.task.id, first.task.id);
  assert.notEqual(child.task.id, first.task.id);
});

test('a terminal scope cannot be reopened by replay or a new source', async () => {
  const store = new TaskStore();
  const first = await store.transitionDevelopmentWork(admit);
  if (!('task' in first)) throw new Error('admission must create the work Task');
  const active = {
    v: 1 as const,
    generation: 1,
    subjectRef: 'deployment:abc123def456:runtime' as const,
    ownerFence: { kind: 'containing_task' as const, generation: 1 },
    baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
    continuation: {
      when: [{ kind: 'new_ready_boot' as const, services: ['api' as const] }],
      // biome-ignore lint/suspicious/noThenProperty: F280 frozen continuation field.
      then: 'verify',
    },
    autoRenew: false as const,
    createdAt: 100,
  };
  assert.ok(
    store.replaceDeploymentWaitIfGeneration(first.task.id, {
      expectedGeneration: null,
      expectedDeploymentWait: first.task.deploymentWait,
      expectedUpdatedAt: first.task.updatedAt,
      deploymentWait: { await: active },
    }),
  );
  store.closeEntrustedWork(first.task.id, {
    expectedRevision: 1,
    closure: { ...contract.closure, state: 'satisfied', evidenceRefs: ['artifact:accepted'] },
  });
  assert.equal(store.get(first.task.id)?.deploymentWait?.await, undefined);
  assert.equal(store.get(first.task.id)?.deploymentWait?.waitOutcome?.reason, 'subject_terminal');
  assert.equal((await store.transitionDevelopmentWork(admit)).result, 'scope_closed');
  assert.equal(
    (await store.transitionDevelopmentWork({ ...admit, sourceRef: 'message:new', idempotencyKey: 'new' })).result,
    'scope_closed',
  );
});

test('legacy adoption keeps id, namespace, source and creation history and fences stale snapshots', async () => {
  const store = new TaskStore();
  const old = store.create({
    threadId: actor.threadId,
    userId: actor.userId,
    ownerCatId: 'codex-sol',
    createdBy: 'user',
    title: 'Existing accepted work',
    why: 'Original evidence',
    subjectKey: 'legacy:phase-b',
  });
  const input = { ...admit, action: 'adopt', taskId: old.id, expectedSnapshot: developmentTaskSnapshot(old) };
  const changed = store.update(old.id, { why: 'New owner fact' });
  assert.equal((await store.transitionDevelopmentWork(input)).result, 'revision_conflict');
  const adopted = await store.transitionDevelopmentWork({
    ...input,
    expectedSnapshot: developmentTaskSnapshot(changed!),
  });
  assert.equal(adopted.result, 'adopted');
  assert.equal(adopted.task.id, old.id);
  assert.equal(adopted.task.createdAt, old.createdAt);
  assert.equal(adopted.task.createdBy, old.createdBy);
  assert.equal(adopted.task.subjectKey, 'legacy:phase-b');
  assert.equal(store.getBySubject('legacy:phase-b')?.id, old.id);
  assert.throws(() =>
    store.upsertBySubject({
      threadId: actor.threadId,
      userId: actor.userId,
      createdBy: 'user',
      title: 'Overwrite',
      why: '',
      subjectKey: 'legacy:phase-b',
    }),
  );
  assert.throws(() => store.delete(old.id));
});

test('binding scope to admitted work keeps its identity; wrong owner and stale resumes are inert', async () => {
  const store = new TaskStore();
  const old = store.admitEntrustedWork({
    subjectKey: 'entrusted:old',
    task: {
      threadId: actor.threadId,
      userId: actor.userId,
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      title: 'Old work',
      why: '',
    },
    entrustedWork: contract,
  });
  const bound = await store.transitionDevelopmentWork({
    ...admit,
    action: 'bind',
    taskId: old.task.id,
    expectedRevision: 1,
  });
  assert.equal(bound.result, 'bound');
  assert.equal(bound.task.subjectKey, 'entrusted:old');
  assert.deepEqual(bound.task.entrustedWork.admission, contract.admission);
  const resume = { ...admit, action: 'resume', taskId: old.task.id, expectedRevision: 1, idempotencyKey: 'later' };
  assert.equal((await store.transitionDevelopmentWork(resume)).result, 'revision_conflict');
  assert.equal(
    (await store.transitionDevelopmentWork({ ...resume, actor: { ...actor, catId: 'opus' } })).result,
    'forbidden',
  );
  assert.equal(store.get(old.task.id)?.entrustedWork?.revision, 2);
});

test('lineage requires the same-user real parent or a terminal predecessor', async () => {
  const store = new TaskStore();
  assert.equal(
    (await store.transitionDevelopmentWork({ ...admit, parentTaskRef: 'task:work:missing' })).result,
    'invalid_transition',
  );
  const parent = await store.transitionDevelopmentWork(admit);
  const child = {
    ...admit,
    idempotencyKey: 'child-lineage',
    scope: { ...scope, workUnitRef: 'file:docs/plans/plan.md#child' },
  };
  assert.equal(
    (await store.transitionDevelopmentWork({ ...child, predecessorTaskRef: `task:work:${parent.task.id}` })).result,
    'invalid_transition',
  );
  assert.equal(
    (await store.transitionDevelopmentWork({ ...child, parentTaskRef: `task:work:${parent.task.id}` })).result,
    'admitted',
  );
});

test('development admission respects capacity without evicting held history', async () => {
  const store = new TaskStore({ maxTasks: 1 });
  const first = await store.transitionDevelopmentWork(admit);
  assert.throws(() =>
    store.transitionDevelopmentWork({
      ...admit,
      idempotencyKey: 'over-capacity',
      scope: { ...scope, workUnitRef: 'file:docs/plans/plan.md#second' },
    }),
  );
  assert.equal(store.size, 1);
  assert.ok(store.get(first.task.id));
});
