import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryWaitLifecycleEventLog } from '../dist/domains/ball-custody/WaitLifecycleEventLog.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { DeploymentWaitRecoverySweep } from '../dist/domains/runtime-deployment/DeploymentWaitRecoverySweep.js';
import { auditGenerationJourney, installDeploymentAwait } from './helpers/deployment-audit-fixture.js';

test('original memory Task keeps unconfirmed exact events across owner/generation replacement and terminal writes', async () => {
  await auditGenerationJourney(new TaskStore());
});

test('audit append failure never acks; committed append before crash converges without observation or wake', async () => {
  const tasks = new TaskStore();
  const task = tasks.create({
    threadId: 'home',
    title: 'terminal audit',
    createdBy: 'codex61-sol',
    ownerCatId: 'codex61-sol',
    userId: 'user',
  });
  await installDeploymentAwait(tasks, task.id);
  tasks.update(task.id, { status: 'done' });
  const events = new MemoryWaitLifecycleEventLog();
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore: tasks,
    eventLog: events,
    currentObservation: async () => assert.fail('audit must never observe/publish/wake'),
    log: { info() {}, warn() {}, error() {} },
  });
  const [entry] = tasks.listDeploymentWaitAuditCandidates();
  const append = events.append.bind(events);
  events.append = async () => {
    throw new Error('append unavailable');
  };
  await assert.rejects(lifecycle.recoverAudit(entry), /append unavailable/);
  assert.equal(tasks.listDeploymentWaitAuditCandidates().length, 1);
  events.append = append;
  await append(entry.event); // Crash after the original event commit, before Task ack.
  assert.equal(await lifecycle.recoverAudit(entry), true);
  assert.equal((await events.read(task.id)).length, 1);
  assert.deepEqual(tasks.listDeploymentWaitAuditCandidates(), []);
  const sweep = new DeploymentWaitRecoverySweep(tasks, { observe: async () => assert.fail('no live wait') }, lifecycle);
  await sweep.run();
  assert.equal((await events.read(task.id)).length, 1);
});

test('memory admission cannot evict a completed Task that still owes its exact audit', async () => {
  const tasks = new TaskStore({ maxTasks: 1 });
  const input = {
    threadId: 'home',
    title: 'pending audit',
    userId: 'user',
    createdBy: 'codex61-sol',
    ownerCatId: 'codex61-sol',
  };
  const task = tasks.create(input);
  await installDeploymentAwait(tasks, task.id);
  tasks.update(task.id, { status: 'done' });
  assert.throws(() => tasks.create(input), /non-evictable/);
  assert.ok(tasks.get(task.id));
  const events = new MemoryWaitLifecycleEventLog();
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore: tasks,
    eventLog: events,
    log: { info() {}, warn() {}, error() {} },
  });
  for (const entry of tasks.listDeploymentWaitAuditCandidates())
    assert.equal(await lifecycle.recoverAudit(entry), true);
  assert.ok(tasks.create(input));
  assert.equal((await events.read(task.id)).length, 1);
});

test('neither an absent EventLog nor a mismatched exact event can acknowledge original audit intent', async () => {
  const tasks = new TaskStore();
  const task = tasks.create({
    threadId: 'home',
    title: 'exact confirmation',
    userId: 'user',
    ownerCatId: 'codex61-sol',
    createdBy: 'codex61-sol',
  });
  await installDeploymentAwait(tasks, task.id);
  tasks.update(task.id, { status: 'done' });
  const [entry] = tasks.listDeploymentWaitAuditCandidates();
  const log = { info() {}, warn() {}, error() {} };
  assert.equal(await new DeploymentWaitLifecycleService({ taskStore: tasks, log }).recoverAudit(entry), false);
  assert.equal(tasks.listDeploymentWaitAuditCandidates().length, 1);
  const events = new MemoryWaitLifecycleEventLog();
  const lifecycle = new DeploymentWaitLifecycleService({ taskStore: tasks, eventLog: events, log });
  assert.equal(await lifecycle.recoverAudit({ ...entry, event: { ...entry.event, ownerCatId: 'codex-astra' } }), false);
  assert.deepEqual(await events.read(task.id), []);
  assert.equal(tasks.listDeploymentWaitAuditCandidates().length, 1);
  assert.equal(await lifecycle.recoverAudit(entry), true);
});

test('normal live waiting is deferred without consuming failures or hiding the user projection', async () => {
  const tasks = new TaskStore();
  const task = tasks.create({
    threadId: 'home',
    title: 'normal wait',
    userId: 'user',
    ownerCatId: 'codex61-sol',
    createdBy: 'codex61-sol',
  });
  await installDeploymentAwait(tasks, task.id);
  let clock = Date.now();
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore: tasks,
    eventLog: new MemoryWaitLifecycleEventLog(),
    log: { info() {}, warn() {}, error() {} },
  });
  const sweep = new DeploymentWaitRecoverySweep(
    tasks,
    { observe: async () => null },
    lifecycle,
    undefined,
    () => clock,
  );
  for (let n = 0; n < 8; n++) {
    await sweep.run();
    assert.equal(tasks.listDueDeploymentWaitRecovery(100, clock).length, 0);
    assert.equal(tasks.listDeploymentWaitProjectionCandidates().length, 1);
    assert.equal(tasks.getDeploymentWaitRecoveryFacts(task.id).live.failures, 0);
    clock += 60_001;
  }
});
