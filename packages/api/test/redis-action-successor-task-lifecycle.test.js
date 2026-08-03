import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ActionSubjectTruthResolver } from '../dist/domains/ball-custody/ActionSubjectTruthResolver.js';
import { ActionSuccessorAdmissionService } from '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js';
import { ActionSuccessorCompletionService } from '../dist/domains/ball-custody/ActionSuccessorCompletionService.js';
import { withBallCustodyTaskEvents } from '../dist/domains/ball-custody/BallCustodyTaskStore.js';
import { RedisActionSuccessorLeaseStore } from '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { TaskActionSuccessorLifecycle } from '../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('task-backed Redis ActionSuccessor lifecycle', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let leaseStore;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'task-backed Redis ActionSuccessor lifecycle');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      leaseStore = new RedisActionSuccessorLeaseStore(redis);
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['action:successor:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['action:successor:*']);
    await redis.quit();
  });

  it('closes an existing-standing implement lease from the persisted task transition', async () => {
    const rawTasks = new TaskStore();
    const task = await rawTasks.create({
      threadId: 'thread-task',
      title: 'Implement F167 task custody',
      why: 'prove the executable task lifecycle',
      ownerCatId: 'opus',
      userId: 'user-1',
      createdBy: 'codex-sol',
    });
    const truthResolver = new ActionSubjectTruthResolver(
      leaseStore,
      {
        async get() {
          return null;
        },
      },
      undefined,
      {
        async get(taskId) {
          return rawTasks.get(taskId);
        },
      },
    );
    const admission = new ActionSuccessorAdmissionService(leaseStore, truthResolver);
    const completion = new ActionSuccessorCompletionService(leaseStore, truthResolver);
    const lifecycle = new TaskActionSuccessorLifecycle({ leaseStore, completionService: completion });
    const tasks = withBallCustodyTaskEvents(rawTasks, { async record() {} }, undefined, lifecycle);

    const admitted = await admission.admit({
      tenantScope: 'user-1',
      actorCatId: 'opus',
      sourceThreadId: 'thread-task',
      targetThreadId: 'thread-task',
      holderCatIds: ['opus'],
      dispatchId: 'existing-standing:task-1',
      evidenceRef: 'message:task-claim',
      now: 200,
      action: {
        subjectRef: `subject:task:${task.id}`,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'existing_standing',
        groundingEvidenceRef: 'message:task-assignment',
        terminalPredicate: { kind: 'task_done' },
      },
    });
    assert.equal(admitted.admit, true);
    assert.equal(admitted.lease.status, 'active');
    assert.equal(
      (
        await leaseStore.getByIdentity({
          tenantScope: 'user-1',
          subjectRef: `subject:task:${task.id}`,
          actionFamily: 'implement',
          successorSlot: 'implementer',
        })
      ).leaseId,
      admitted.lease.leaseId,
    );
    assert.deepEqual(
      (await leaseStore.listActiveTaskLeases()).map((lease) => lease.leaseId),
      [admitted.lease.leaseId],
    );

    await tasks.update(task.id, { status: 'done' });
    const completed = await leaseStore.get(admitted.lease.leaseId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.holderOutcomes.opus.outcome, 'succeeded');
    assert.match(completed.holderOutcomes.opus.evidenceRef, new RegExp(`^task:${task.id}:done:`));
    assert.deepEqual(await leaseStore.listActiveTaskLeases(), []);
  });

  it('retains original and replacement standing evidence through real admission and Redis replacement', async () => {
    const rawTasks = new TaskStore();
    const task = await rawTasks.create({
      threadId: 'thread-task',
      title: 'Replace F167 task custody',
      why: 'prove replacement preserves the complete standing evidence chain',
      ownerCatId: 'codex-sol',
      userId: 'user-1',
      createdBy: 'codex-sol',
    });
    const truthResolver = new ActionSubjectTruthResolver(
      leaseStore,
      {
        async get() {
          return null;
        },
      },
      undefined,
      {
        async get(taskId) {
          return rawTasks.get(taskId);
        },
      },
    );
    const admission = new ActionSuccessorAdmissionService(leaseStore, truthResolver);
    const subjectRef = `subject:task:${task.id}`;
    const action = {
      subjectRef,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
      groundingEvidenceRef: 'message:original-task-assignment',
      terminalPredicate: { kind: 'task_done' },
    };

    const admitted = await admission.admit({
      tenantScope: 'user-1',
      actorCatId: 'codex-sol',
      sourceThreadId: 'thread-task',
      targetThreadId: 'thread-task',
      holderCatIds: ['codex-sol'],
      dispatchId: 'existing-standing:task-replace:g1',
      evidenceRef: 'message:initial-request',
      now: 200,
      action,
    });
    assert.equal(admitted.admit, true);
    const initialFreshnessEvidenceRef = admitted.lease.evidenceRefs[1];
    assert.match(initialFreshnessEvidenceRef, new RegExp(`^task:${task.id}:active:`));
    assert.deepEqual(admitted.lease.evidenceRefs, [
      'message:initial-request',
      initialFreshnessEvidenceRef,
      'message:original-task-assignment',
    ]);

    await admission.markUnavailable({
      fence: { leaseId: admitted.lease.leaseId, generation: 1 },
      holderCatIds: ['codex-sol'],
      evidenceRef: 'queue:not_enqueued',
      now: 210,
    });

    const replaced = await admission.admit({
      tenantScope: 'user-1',
      actorCatId: 'codex-sol',
      sourceThreadId: 'thread-task',
      targetThreadId: 'thread-task',
      holderCatIds: ['codex-sol'],
      dispatchId: 'existing-standing:task-replace:g2',
      evidenceRef: 'message:replacement-request',
      now: 220,
      action: {
        ...action,
        groundingEvidenceRef: 'message:replacement-grounding',
        replace: { leaseId: admitted.lease.leaseId, expectedGeneration: 1 },
      },
    });

    assert.equal(replaced.admit, true);
    assert.equal(replaced.outcome, 'replaced');
    assert.equal(replaced.lease.generation, 2);
    assert.equal(replaced.lease.issuerStandingEvidenceRef, 'message:replacement-grounding');
    assert.deepEqual(replaced.lease.evidenceRefs, [
      'message:initial-request',
      initialFreshnessEvidenceRef,
      'message:original-task-assignment',
      'queue:not_enqueued',
      'message:replacement-request',
      'message:replacement-grounding',
    ]);
  });
});
