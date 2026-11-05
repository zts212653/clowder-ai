import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RedisWaitLifecycleEventLog } from '../dist/domains/ball-custody/WaitLifecycleEventLog.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { auditGenerationJourney, installDeploymentAwait } from './helpers/deployment-audit-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';

const fixture = ownedRedisFixture('1843-deployment-recovery');
const log = { info() {}, warn() {}, error() {} };

test('Redis Task audit metadata keeps all exact intents, stale acknowledgements cannot cross outcomes or generation', async () => {
  const redis = fixture.client(`deployment-audit-${randomUUID()}:`);
  const tasks = new RedisTaskStore(redis);
  const id = await auditGenerationJourney(tasks);
  await tasks.initializeDeploymentWaitRecovery(true);
  assert.deepEqual(await new RedisTaskStore(redis).listDeploymentWaitAuditCandidates(), []);
  const business = await tasks.get(id);
  assert.equal(business.status, 'done');
  assert.equal(business.ownerCatId, null);
});

test('a persistent audit append failure parks after five attempts; original business and intent survive rebuild', async () => {
  const redis = fixture.client(`deployment-audit-budget-${randomUUID()}:`);
  const tasks = new RedisTaskStore(redis);
  const task = await tasks.create({
    threadId: 'home',
    title: 'audit failure',
    userId: 'user',
    createdBy: 'codex61-sol',
    ownerCatId: 'codex61-sol',
  });
  await installDeploymentAwait(tasks, task.id);
  await tasks.update(task.id, { status: 'done' });
  const snapshot = await tasks.get(task.id);
  for (let n = 0; n < 5; n++) {
    const [entry] = await tasks.listDeploymentWaitAuditCandidates(1, Date.now() + n * 60_001);
    assert.ok(entry);
    await tasks.failDeploymentWaitAudit(entry, Date.now() + n * 60_001);
  }
  assert.deepEqual(await tasks.listDeploymentWaitAuditCandidates(1, Date.now() + 1_000_000), []);
  const facts = await tasks.getDeploymentWaitRecoveryFacts(task.id);
  const [entry] = Object.values(facts.pending);
  assert.equal(entry.disposition, 'needs_attention');
  assert.equal(entry.failures, 5);
  await tasks.initializeDeploymentWaitRecovery(true);
  assert.deepEqual(await tasks.listDeploymentWaitAuditCandidates(1, Date.now() + 1_000_000), []);
  assert.deepEqual(await tasks.get(task.id), snapshot);
  // A later explicit exact-event confirmation may acknowledge a parked audit, without reopening work.
  const events = new RedisWaitLifecycleEventLog(redis);
  const lifecycle = new DeploymentWaitLifecycleService({ taskStore: tasks, eventLog: events, log });
  assert.equal(await lifecycle.recoverAudit(entry), true);
  assert.equal((await events.read(task.id)).length, 1);
  assert.deepEqual(await tasks.get(task.id), snapshot);
});

test('confirmed history grows tenfold without expanding periodic Redis reads; append-before-ack crash is idempotent', async () => {
  for (const history of [100, 1000]) {
    const redis = fixture.client(`deployment-audit-history-${history}-${randomUUID()}:`);
    const tasks = new RedisTaskStore(redis),
      events = new RedisWaitLifecycleEventLog(redis);
    const task = await tasks.create({
      threadId: 'home',
      title: 'fixed pending audit',
      userId: 'user',
      createdBy: 'codex61-sol',
      ownerCatId: 'codex61-sol',
    });
    await installDeploymentAwait(tasks, task.id);
    await tasks.update(task.id, { status: 'done' });
    const [entry] = await tasks.listDeploymentWaitAuditCandidates();
    const pipeline = redis.pipeline();
    for (let n = 0; n < history; n++) {
      const id = `history-${n}`,
        outcomeId = `old-outcome-${n}`;
      pipeline.hset(`task:${id}`, {
        id,
        kind: 'work',
        status: 'done',
        updatedAt: '1',
        deploymentWait: JSON.stringify({
          waitOutcome: {
            v: 1,
            domain: 'deployment',
            outcomeId,
            generation: 1,
            subjectRef: 'deployment:abc123def456:runtime',
            ownerFence: { kind: 'containing_task', generation: 1 },
            reason: 'subject_terminal',
            delivery: 'not_applicable',
            at: 1,
          },
        }),
        _deploymentRecovery: JSON.stringify({ capturedOutcomeId: outcomeId, pending: {} }),
      });
      pipeline.zadd('tasks:kind:work', 1, id);
      pipeline.rpush(`wait-lifecycle:events:${task.id}`, JSON.stringify({ ...entry.event, eventId: `confirmed-${n}` }));
      pipeline.sadd('wait-lifecycle:events:seen', `confirmed-${n}`);
    }
    for (const [error] of await pipeline.exec()) assert.equal(error, null);
    await tasks.initializeDeploymentWaitRecovery(true);
    await events.initializeExactIndex(task.id); // One migration; periodic work cannot re-read this history.
    await events.append(entry.event); // Persisted append, Task ack not committed before crash.
    const coldTasks = new RedisTaskStore(redis),
      coldEvents = new RedisWaitLifecycleEventLog(redis);
    const lifecycle = new DeploymentWaitLifecycleService({ taskStore: coldTasks, eventLog: coldEvents, log });
    const audit = await auditRecoveryRedis(redis);
    try {
      assert.deepEqual(await coldTasks.listDeploymentWaitProjectionCandidates(), []);
      const pending = await coldTasks.listDeploymentWaitAuditCandidates();
      assert.equal(pending.length, 1);
      assert.equal(await lifecycle.recoverAudit(pending[0]), true);
      assert.deepEqual(await coldTasks.listDeploymentWaitAuditCandidates(), []);
      await audit.flush();
      audit.assertIndexed();
      assert.ok(audit.reads.length < 45, 'only fixed due work may cause Redis reads');
      assert.equal(audit.reads.filter((read) => read.command === 'lrange').length, 0);
      assert.equal((await coldEvents.read(task.id)).length, history + 1);
    } finally {
      audit.stop();
    }
    await coldTasks.initializeDeploymentWaitRecovery(true);
    assert.deepEqual(await coldTasks.listDeploymentWaitAuditCandidates(), []);
  }
});

test('exact EventLog confirmation rejects eventId collisions and cannot leave seen-only writes on index failure', async () => {
  const redis = fixture.client(`deployment-audit-exact-${randomUUID()}:`);
  const events = new RedisWaitLifecycleEventLog(redis);
  const event = {
    v: 1,
    eventId: 'exact',
    kind: 'wait.terminated',
    waitId: 'wait',
    waitKind: 'deployment',
    subjectRef: 'deployment:abc123def456:runtime',
    threadId: 'home',
    ownerUserId: 'user',
    ownerCatId: 'codex61-sol',
    generation: 1,
    reason: 'subject_terminal',
    at: 100,
    actor: { kind: 'system' },
  };
  assert.equal((await events.append(event)).confirmed, true);
  assert.equal((await new RedisWaitLifecycleEventLog(redis).append({ ...event })).appended, false);
  await assert.rejects(events.append({ ...event, ownerCatId: 'codex-astra' }), /wait_event_identity_conflict/);
  await redis.set('wait-lifecycle:exact:other', 'invalid exact index');
  await assert.rejects(events.append({ ...event, waitId: 'other', eventId: 'new-event' }), /invalid_wait_event_index/);
  assert.equal(await redis.sismember('wait-lifecycle:events:seen', 'new-event'), 0);
  assert.equal(await redis.llen('wait-lifecycle:events:other'), 0);
});

test('legacy audit with no trustworthy original owner remains explicitly unknown, never attributed to the new owner', async () => {
  const redis = fixture.client(`deployment-audit-unknown-${randomUUID()}:`);
  const tasks = new RedisTaskStore(redis);
  await redis.hset('task:unknown', {
    id: 'unknown',
    kind: 'work',
    status: 'done',
    threadId: 'new-thread',
    userId: 'user',
    ownerCatId: 'codex-astra',
    updatedAt: '100',
    deploymentWait: JSON.stringify({
      waitOutcome: {
        v: 1,
        domain: 'deployment',
        outcomeId: 'old-owner-change',
        generation: 1,
        subjectRef: 'deployment:abc123def456:runtime',
        ownerFence: { kind: 'containing_task', generation: 1 },
        reason: 'owner_changed',
        delivery: 'not_applicable',
        at: 100,
      },
    }),
  });
  await redis.zadd('tasks:kind:work', 1, 'unknown');
  await tasks.initializeDeploymentWaitRecovery();
  assert.deepEqual(await tasks.listDeploymentWaitAuditCandidates(), []);
  const [entry] = Object.values((await tasks.getDeploymentWaitRecoveryFacts('unknown')).pending);
  assert.equal(entry.disposition, 'needs_attention');
  assert.equal(entry.reasonCode, 'original_wait_owner_unknown');
  assert.equal(entry.event.ownerCatId, '');
});

test('a failed typed-wait write cannot commit a new receipt independently of its original Task', async () => {
  const redis = fixture.client(`deployment-audit-atomic-${randomUUID()}:`);
  const tasks = new RedisTaskStore(redis);
  const task = await tasks.create({
    threadId: 'home',
    title: 'atomic wait',
    userId: 'user',
    ownerCatId: 'codex61-sol',
    createdBy: 'codex61-sol',
  });
  const snapshot = await tasks.getWaitRegistration(task.id);
  await redis.set('tasks:deployment-wait:live:due', 'invalid index');
  await assert.rejects(installDeploymentAwait(tasks, task.id), /invalid_deployment_recovery_index/);
  assert.deepEqual(await tasks.getWaitRegistration(task.id), snapshot);
});
