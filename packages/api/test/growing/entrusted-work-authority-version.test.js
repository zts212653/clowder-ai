import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareDevelopmentWorkTransition } from '../../dist/domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import { createEntrustedTaskItem } from '../../dist/domains/cats/services/stores/ports/TaskItemFactory.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { hydrateTask, serializeTask } from '../../dist/domains/cats/services/stores/redis/RedisTaskCodec.js';
import { EntrustedWorkLifecycleService } from '../../dist/domains/growing/EntrustedWorkLifecycleService.js';

async function fixture() {
  const store = new TaskStore();
  const lifecycle = new EntrustedWorkLifecycleService(store);
  const result = await lifecycle.admitOrResume({
    task: {
      threadId: 'thread',
      title: 'Report',
      why: 'Entrusted',
      createdBy: 'codex',
      ownerCatId: 'codex',
      userId: 'owner',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source'],
      intendedOutcome: 'Report',
      idempotencyKey: 'source',
    },
    closure: { condition: 'Report accepted', expectedSignal: 'artifact:accepted' },
  });
  return { store, lifecycle, task: store.get(result.ownerRef.replace('task:item:', '')) };
}

test('authority version starts at the Task owner and survives the Redis codec', async () => {
  const { task } = await fixture();
  assert.equal(task.entrustedWork.executionAuthorityRevision, 1);
  assert.deepEqual(hydrateTask(serializeTask(task)).entrustedWork, task.entrustedWork);
});

for (const [name, patch] of [
  ['status', { status: 'doing' }],
  ['time', { time: { actualStart: { value: 100, sourceRef: 'message:source' } } }],
  ['artifact-only generic update', { artifactRefs: ['artifact:one'] }],
  ['progress', { progress: { summary: 'Drafting', sourceRef: 'message:source' } }],
]) {
  test(`ordinary ${name} mutation advances aggregate and authority revisions together`, async () => {
    const { store, task } = await fixture();
    // Distinct counters prove the next authority value is not copied from aggregate revision.
    task.entrustedWork.revision = 8;
    task.entrustedWork.executionAuthorityRevision = 3;
    const result = store.updateEntrustedWork(task.id, { expectedRevision: 8, ...patch });
    assert.equal(result.kind, 'updated');
    assert.equal(result.task.entrustedWork.revision, 9);
    assert.equal(result.task.entrustedWork.executionAuthorityRevision, 4);
  });
}

test('typed close advances authority; stale aggregate CAS cannot change either counter', async () => {
  const { store, task } = await fixture();
  task.entrustedWork.executionAuthorityRevision = 3;
  const closure = { ...task.entrustedWork.closure, state: 'satisfied', evidenceRefs: ['message:accepted'] };
  const before = structuredClone(task);
  assert.equal(store.closeEntrustedWork(task.id, { expectedRevision: 0, closure }).kind, 'revision_conflict');
  assert.deepEqual(store.get(task.id), before);
  const closed = store.closeEntrustedWork(task.id, { expectedRevision: 1, closure });
  assert.equal(closed.kind, 'closed');
  assert.equal(closed.task.entrustedWork.executionAuthorityRevision, 4);
});

for (const mutation of ['patchAutomation', 'replaceAutomation', 'replaceDeployment']) {
  test(`${mutation} invalidates an entrusted execution through the shared Task owner`, async () => {
    const { store, task } = await fixture();
    task.entrustedWork.executionAuthorityRevision = 3;
    const updated =
      mutation === 'patchAutomation'
        ? store.patchAutomationState(task.id, { closedAt: 10 })
        : mutation === 'replaceAutomation'
          ? store.replaceAutomationStateIfGeneration(task.id, {
              expectedGeneration: null,
              automationState: { closedAt: 10 },
              status: 'doing',
            })
          : store.replaceDeploymentWaitIfGeneration(task.id, {
              expectedGeneration: null,
              expectedDeploymentWait: undefined,
              deploymentWait: undefined,
              status: 'blocked',
            });
    assert.ok(updated);
    assert.equal(updated.entrustedWork.revision, 2);
    assert.equal(updated.entrustedWork.executionAuthorityRevision, 4);
  });
}

test('legacy aggregate remains legacy after ordinary mutation and codec reconstruction', async () => {
  const { store, task } = await fixture();
  delete task.entrustedWork.executionAuthorityRevision;
  const updated = store.updateEntrustedWork(task.id, { expectedRevision: 1, artifactRefs: ['artifact:legacy'] });
  assert.equal(updated.kind, 'updated');
  assert.equal(Object.hasOwn(updated.task.entrustedWork, 'executionAuthorityRevision'), false);
  assert.equal(
    Object.hasOwn(hydrateTask(serializeTask(updated.task)).entrustedWork, 'executionAuthorityRevision'),
    false,
  );
});

test('no-op and failed update CAS leave complete Task bytes unchanged', async () => {
  const { store, task } = await fixture();
  const before = structuredClone(task);
  assert.equal(store.updateEntrustedWork(task.id, { expectedRevision: 1, status: 'todo' }).kind, 'no_change');
  assert.equal(store.updateEntrustedWork(task.id, { expectedRevision: 2, status: 'doing' }).kind, 'revision_conflict');
  assert.deepEqual(store.get(task.id), before);
});

test('development bind cannot retain execution authority across new scope admission', async () => {
  const { task } = await fixture();
  task.entrustedWork.executionAuthorityRevision = 3;
  const result = prepareDevelopmentWorkTransition(
    {
      action: 'bind',
      actor: { userId: 'owner', threadId: 'thread', catId: 'codex' },
      scope: {
        featureRef: 'feature:F202',
        phaseKey: 'C1',
        workUnitRef: 'feature-phase:F202:C1',
        acceptedSourceRef: 'file:docs/features/F202.md',
        acceptedRevision: 'a'.repeat(40),
      },
      sourceRef: 'message:next',
      sourceRevision: '1',
      idempotencyKey: 'next',
      taskId: task.id,
      expectedRevision: 1,
    },
    [],
    task,
    null,
  );
  assert.equal(result.result, 'write');
  assert.equal(result.task.entrustedWork.revision, 2);
  assert.equal(result.task.entrustedWork.executionAuthorityRevision, 4);
});

test('authority version overflow refuses rather than becoming non-monotonic', async () => {
  const { store, task } = await fixture();
  task.entrustedWork.executionAuthorityRevision = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(task);
  assert.throws(() => store.updateEntrustedWork(task.id, { expectedRevision: 1, artifactRefs: ['artifact:overflow'] }));
  assert.deepEqual(store.get(task.id), before);
});

test('fresh Task factory owns the initial epoch; a proposed epoch cannot grant a caller-selected version', async () => {
  const { task } = await fixture();
  const created = createEntrustedTaskItem({
    subjectKey: 'entrusted:new',
    task,
    entrustedWork: { ...task.entrustedWork, executionAuthorityRevision: 999 },
  });
  assert.equal(created.entrustedWork.executionAuthorityRevision, 1);
});

test('metadata writes keep a legacy Task unversioned instead of inferring its execution epoch', async () => {
  const { store, task } = await fixture();
  delete task.entrustedWork.executionAuthorityRevision;
  const updated = store.patchAutomationState(task.id, { closedAt: 10 });
  assert.equal(updated.entrustedWork.revision, 2);
  assert.equal(Object.hasOwn(updated.entrustedWork, 'executionAuthorityRevision'), false);
});
