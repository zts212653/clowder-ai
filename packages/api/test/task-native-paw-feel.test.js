import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { PawFeelDispositionCommandSchema } from '../dist/infrastructure/harness-eval/paw-feel-disposition/commands.js';
import { PawFeelFixEvidenceResolver } from '../dist/infrastructure/harness-eval/paw-feel-disposition/route-evidence-resolver.js';
import { PawFeelDispositionService } from '../dist/infrastructure/harness-eval/paw-feel-disposition/service.js';
import {
  MemoryPawFeelEventLog,
  pawFeelCandidate,
} from './harness-eval/helpers/paw-feel-disposition-service-fixture.js';

test('F278 binds an exact ordinary assignment without reading a lease, separates open responsibility and done truth', async () => {
  const tasks = new TaskStore();
  const task = tasks.create({
    threadId: 'home',
    title: 'original repair',
    ownerCatId: 'codex',
    createdBy: 'codex',
    userId: 'tenant',
  });
  const resolver = new PawFeelFixEvidenceResolver({
    taskStore: tasks,
    leaseStore: {
      get() {
        throw new Error('ordinary must not read leases');
      },
      preflight() {
        throw new Error('ordinary must not preflight leases');
      },
    },
  });
  const request = { kind: 'task_assignment', taskId: task.id, expectedOwnerRevision: 0 };
  const fix = await resolver.resolve(request, 'tenant');
  assert.equal(fix.ownerCatId, 'codex');
  assert.deepEqual(fix.repairBinding, {
    kind: 'task_assignment',
    taskId: task.id,
    ownerRevision: 0,
    taskThreadId: 'home',
  });
  assert.equal(fix.custodyEvidenceRef, `task:${task.id}:assignment:0`);
  assert.equal('leaseId' in fix, false);
  const projection = { ...fix, signalId: 'signal', state: 'fix' };
  assert.equal((await resolver.resolveProgress(projection)).status, 'active');
  tasks.update(task.id, { status: 'done' });
  await assert.rejects(resolver.resolve(request, 'tenant'), /done/);
  assert.equal((await resolver.resolveProgress(projection)).status, 'done_unverified');
  const terminal = await resolver.resolveTerminal(projection, { ownerCatId: 'codex' });
  assert.equal('leaseTerminalRef' in terminal, false);
  assert.equal(terminal.taskTerminalRef.ownerStateRef, `task-terminal:${task.id}`);
});
test('F278 task assignment requires exact version, tenant and ordinary kind', async () => {
  const tasks = new TaskStore();
  const task = tasks.create({
    threadId: 'home',
    title: 'repair',
    ownerCatId: 'codex',
    userId: 'tenant',
    createdBy: 'codex',
  });
  const resolver = new PawFeelFixEvidenceResolver({ taskStore: tasks });
  const request = { kind: 'task_assignment', taskId: task.id, expectedOwnerRevision: 0 };
  await assert.rejects(resolver.resolve(request, 'foreign'), /tenant/);
  await assert.rejects(resolver.resolve({ ...request, expectedOwnerRevision: 1 }, 'tenant'), /revision/);
  tasks.update(task.id, { ownerCatId: 'sonnet' });
  tasks.update(task.id, { ownerCatId: 'codex' });
  await assert.rejects(resolver.resolve(request, 'tenant'), /revision/);
  const namespaced = tasks.create({
    threadId: 'home',
    title: 'governed',
    subjectKey: 'eval-case:repair',
    ownerCatId: 'codex',
    userId: 'tenant',
    createdBy: 'codex',
  });
  await assert.rejects(resolver.resolve({ ...request, taskId: namespaced.id }, 'tenant'), /ordinary/);
});
test('fix and frozen-signature commands take exact repair binding references, never caller owner/evidence', () => {
  const base = { eventId: 'fix', signalId: 'signal', expectedSequence: 1 };
  const repairBinding = { kind: 'task_assignment', taskId: 'task', expectedOwnerRevision: 0 };
  assert.equal(
    PawFeelDispositionCommandSchema.safeParse({ ...base, type: 'mark_fix', repairBinding, actionRef: 'action' })
      .success,
    true,
  );
  assert.equal(
    PawFeelDispositionCommandSchema.safeParse({
      ...base,
      type: 'request_signature',
      action: { type: 'fix', repairBinding, actionRef: 'action' },
    }).success,
    true,
  );
  assert.equal(
    PawFeelDispositionCommandSchema.safeParse({
      ...base,
      type: 'mark_fix',
      repairBinding: { ...repairBinding, ownerCatId: 'forged' },
      actionRef: 'action',
    }).success,
    false,
  );
  assert.equal(
    PawFeelDispositionCommandSchema.safeParse({
      ...base,
      type: 'mark_fix',
      repairBinding: { kind: 'task_assignment', taskId: 'task' },
      actionRef: 'action',
    }).success,
    false,
  );
});
test('F278 signed candidate freezes assignment across ABA, idempotent replay and fix-to-fix rebind keep the same history', async () => {
  const tasks = new TaskStore();
  const task = tasks.create({
    threadId: 'home',
    title: 'repair',
    ownerCatId: 'codex',
    userId: 'tenant',
    createdBy: 'codex',
  });
  const resolver = new PawFeelFixEvidenceResolver({ taskStore: tasks });
  const eventLog = new MemoryPawFeelEventLog();
  const ref = (ownerStateRef) => ({ ownerFeatureId: 'F278', ownerStateRef: `fixture:${ownerStateRef}` });
  const service = new PawFeelDispositionService({
    eventLog,
    directRepairResolver: {
      async resolve(input) {
        const fix = await resolver.resolve(input.repairBinding, input.userId);
        return {
          status: 'authorized',
          fix,
          binding: {
            schemaVersion: 1,
            bindingRef: ref('binding'),
            sourceSignalRef: ref('signal'),
            sourceToolRef: ref('tool'),
            providerId: 'fixture',
            providerVersion: 'v1',
            providerRouteRef: ref('provider'),
            resolvedActionRef: ref('action'),
            actionScopeRef: ref('scope'),
            ownerAuthorizationRef: ref('original-authority'),
            targetVersionRef: { ...ref('target'), version: 'v1', assetKind: 'fixture', assetId: 'target' },
            ownerCatId: fix.ownerCatId,
            outcomeVerifierRef: ref('verifier'),
          },
        };
      },
    },
  });
  const source = pawFeelCandidate();
  await service.discover(source, { backfilled: false });
  const repairBinding = { kind: 'task_assignment', taskId: task.id, expectedOwnerRevision: 0 };
  const command = {
    type: 'request_signature',
    eventId: 'candidate',
    signalId: source.signalId,
    expectedSequence: 1,
    action: { type: 'fix', repairBinding, actionRef: 'action' },
  };
  const first = await service.execute({ kind: 'cat', id: 'codex' }, command, { userId: 'tenant' });
  assert.equal(first.outcome, 'appended');
  assert.equal(
    (await service.execute({ kind: 'cat', id: 'codex' }, command, { userId: 'tenant' })).outcome,
    'duplicate',
  );
  const sign = {
    type: 'mark_fix',
    eventId: 'signature',
    signalId: source.signalId,
    expectedSequence: 2,
    repairBinding,
    actionRef: 'action',
  };
  tasks.update(task.id, { ownerCatId: 'sonnet' });
  tasks.update(task.id, { ownerCatId: 'codex' });
  await assert.rejects(service.execute({ kind: 'cat', id: 'sonnet' }, sign, { userId: 'tenant' }), /revision/);
  await assert.rejects(
    service.execute(
      { kind: 'cat', id: 'sonnet' },
      { ...sign, repairBinding: { ...repairBinding, expectedOwnerRevision: 2 } },
      { userId: 'tenant' },
    ),
    /candidate|signature/,
  );
  assert.equal((await eventLog.read(source.signalId)).length, 2);
  const secondSource = pawFeelCandidate({ messageId: 'direct-fix' });
  await service.discover(secondSource, { backfilled: false });
  const direct = {
    ...sign,
    signalId: secondSource.signalId,
    eventId: 'fix-2',
    expectedSequence: 1,
    repairBinding: { ...repairBinding, expectedOwnerRevision: 2 },
  };
  const bound = await service.execute({ kind: 'cat', id: 'codex' }, direct, { userId: 'tenant' });
  assert.equal(bound.outcome, 'appended');
  assert.equal(bound.projection.actionLeaseRef, undefined);
  assert.equal(bound.projection.repairBinding?.kind, 'task_assignment');
  tasks.update(task.id, { ownerCatId: 'sonnet' });
  assert.equal(
    (
      await service.execute(
        { kind: 'cat', id: 'sonnet' },
        {
          ...direct,
          eventId: 'rebind',
          expectedSequence: 2,
          repairBinding: { ...repairBinding, expectedOwnerRevision: 3 },
        },
        { userId: 'tenant' },
      )
    ).outcome,
    'appended',
  );
  const before = (await eventLog.read(secondSource.signalId)).length;
  await assert.rejects(
    service.execute(
      { kind: 'cat', id: 'sonnet' },
      {
        ...direct,
        eventId: 'foreign',
        expectedSequence: before,
        repairBinding: { ...repairBinding, expectedOwnerRevision: 3 },
      },
      { userId: 'foreign' },
    ),
    /tenant/,
  );
  assert.equal((await eventLog.read(secondSource.signalId)).length, before);
});
