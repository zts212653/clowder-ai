import assert from 'node:assert/strict';
import { createTypedWaitRegistration } from '../../dist/domains/ball-custody/TypedWaitRegistration.js';

export function deploymentAwait(generation = 1) {
  return {
    v: 1,
    generation,
    subjectRef: 'deployment:abc123def456:runtime',
    ownerFence: { kind: 'containing_task', generation },
    baseline: { bootSequence: 1, bootId: 'boot-1', capturedAt: 100 },
    continuation: {
      when: [{ kind: 'new_ready_boot', services: ['api'] }],
      // biome-ignore lint/suspicious/noThenProperty: Frozen continuation contract.
      then: 'Verify original work',
    },
    autoRenew: false,
    createdAt: 100,
  };
}
export async function installDeploymentAwait(tasks, taskId, generation = 1) {
  const task = await tasks.get(taskId),
    active = deploymentAwait(generation);
  const receipt = createTypedWaitRegistration({
    task,
    active,
    invocationId: `inv-${generation}`,
    source: { kind: 'primary', sourceMessageId: `source-${generation}` },
  });
  const installed = await tasks.replaceDeploymentWaitIfGeneration(taskId, {
    expectedGeneration: task.deploymentWait?.await?.generation ?? task.deploymentWait?.waitOutcome?.generation ?? null,
    expectedDeploymentWait: task.deploymentWait,
    deploymentWait: { await: active },
    waitRegistration: receipt,
  });
  assert.ok(installed);
  return installed;
}
export async function installMatched(tasks, taskId) {
  const task = await tasks.get(taskId),
    active = task.deploymentWait.await;
  return tasks.replaceDeploymentWaitIfGeneration(taskId, {
    expectedGeneration: active.generation,
    expectedDeploymentWait: task.deploymentWait,
    deploymentWait: {
      waitOutcome: {
        v: 1,
        domain: 'deployment',
        outcomeId: `wait:${active.subjectRef}:g${active.generation}:matched`,
        subjectRef: active.subjectRef,
        generation: active.generation,
        ownerFence: active.ownerFence,
        reason: 'matched',
        delivery: 'delivered',
        at: 200,
        actor: { kind: 'system' },
      },
    },
  });
}

export async function auditGenerationJourney(tasks) {
  const task = await tasks.create({
    threadId: 'original-thread',
    title: 'audit responsibility',
    createdBy: 'codex61-sol',
    ownerCatId: 'codex61-sol',
    userId: 'user',
  });
  await installDeploymentAwait(tasks, task.id);
  await installMatched(tasks, task.id);
  const [matched] = await tasks.listDeploymentWaitAuditCandidates();
  assert.equal(matched.event.reason, 'matched');
  await tasks.update(task.id, { ownerCatId: 'codex-astra', threadId: 'new-thread' });
  const first = await tasks.listDeploymentWaitAuditCandidates();
  assert.equal(first.length, 2, 'same-generation terminal outcome must not overwrite the matched event');
  const ownerChanged = first.find((entry) => entry.event.reason === 'owner_changed');
  assert.equal(ownerChanged.event.ownerCatId, 'codex61-sol');
  assert.equal(ownerChanged.event.threadId, 'original-thread');
  await installDeploymentAwait(tasks, task.id, 2);
  await tasks.update(task.id, { ownerCatId: null, status: 'done' });
  const snapshot = await tasks.get(task.id);
  assert.deepEqual(await tasks.listDeploymentWaitProjectionCandidates(), []);
  assert.equal(await tasks.ackDeploymentWaitAudit(matched), true);
  assert.equal(await tasks.ackDeploymentWaitAudit(matched), false);
  const remaining = await tasks.listDeploymentWaitAuditCandidates();
  assert.equal(remaining.length, 2, 'late g1 matched ack cannot remove g1 terminal or g2 terminal audit');
  assert.equal(remaining.find((entry) => entry.event.generation === 2).event.ownerCatId, 'codex-astra');
  for (const entry of remaining) await tasks.ackDeploymentWaitAudit(entry);
  assert.deepEqual(await tasks.get(task.id), snapshot, 'metadata ack cannot mutate Task/status/time/authority/outcome');
  assert.deepEqual(await tasks.listDeploymentWaitAuditCandidates(), []);
  return task.id;
}
