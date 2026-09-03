import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f311-program-lifecycle-test:';

const targetRef = {
  ownerFeatureId: 'F202',
  ownerStateRef: 'skill:video-forge',
  version: 'v1',
};

describe('F311 Evolution Program lifecycle (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let EvolutionProgramKeys;
  let EvolutionProgramService;
  let RedisEvolutionProgramEventLog;
  let redis;
  let eventLog;
  let service;
  let tick;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F311EvolutionProgramLifecycle');
    ({ EvolutionProgramKeys, RedisEvolutionProgramEventLog } = await import(
      '../dist/infrastructure/capability-evolution/program-event-log.js'
    ));
    ({ EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    tick = 0;
    eventLog = new RedisEvolutionProgramEventLog(redis);
    service = new EvolutionProgramService({
      eventLog,
      now: () => new Date(Date.parse('2026-08-31T20:00:00.000Z') + tick++ * 1_000).toISOString(),
    });
  });

  async function createProgram(clientMessageId = 'message-create-1') {
    return service.create({
      workspaceId: 'user:operator',
      targetRef,
      clientMessageId,
      actorRef: 'cat:codex-sol',
      originRef: `thread:thread-f311:message:${clientMessageId}`,
    });
  }

  it('creates one canonical Program with deterministic draft refs and typed blockers', async () => {
    const created = await createProgram();

    assert.equal(created.outcome, 'appended');
    assert.equal(created.projection.program.workspaceId, 'user:operator');
    assert.deepEqual(created.projection.program.objectRef, targetRef);
    assert.equal(created.projection.program.lifecycle, 'active');
    assert.equal(created.projection.program.stage, 'constituting');
    assert.match(created.projection.program.claimRef.ownerStateRef, /^evolution-claim:/);
    assert.match(created.projection.drafts.goal.ownerStateRef, /^evolution-goal-draft:/);
    assert.match(created.projection.drafts.economic.ownerStateRef, /^evolution-economic-draft:/);
    assert.match(created.projection.drafts.measurement.ownerStateRef, /^evolution-measurement-draft:/);
    assert.match(created.projection.drafts.roles.observer.ownerStateRef, /^evolution-role-draft:/);
    assert.match(created.projection.drafts.roles.calibrator.ownerStateRef, /^evolution-role-draft:/);
    assert.ok(created.projection.blockers.some((blocker) => blocker.code === 'measurement_certificate_missing'));
    assert.ok(created.projection.blockers.some((blocker) => blocker.code === 'calibrator_missing'));
    assert.equal(created.projection.nextAction.code, 'complete_constitution');
  });

  it('replays through a fresh service instance and lists only the caller workspace', async () => {
    const created = await createProgram();
    await service.create({
      workspaceId: 'user:someone-else',
      targetRef: { ownerFeatureId: 'F208', ownerStateRef: 'dossier:opus' },
      clientMessageId: 'message-other-user',
      actorRef: 'cat:opus',
      originRef: 'thread:other:message:message-other-user',
    });

    const restarted = new EvolutionProgramService({ eventLog: new RedisEvolutionProgramEventLog(redis) });
    assert.deepEqual(await restarted.get(created.projection.program.programId), created.projection);
    const listed = await restarted.list('user:operator');
    assert.deepEqual(
      listed.map((projection) => projection.program.programId),
      [created.projection.program.programId],
    );
  });

  it('scopes client idempotency to the Program instead of colliding across workspaces', async () => {
    const first = await createProgram('message-shared-by-two-workspaces');
    const second = await service.create({
      workspaceId: 'user:someone-else',
      targetRef: { ownerFeatureId: 'F208', ownerStateRef: 'dossier:opus' },
      clientMessageId: 'message-shared-by-two-workspaces',
      actorRef: 'cat:opus',
      originRef: 'thread:other:message:message-shared-by-two-workspaces',
    });

    assert.equal(first.outcome, 'appended');
    assert.equal(second.outcome, 'appended');
    assert.notEqual(first.projection.program.programId, second.projection.program.programId);
  });

  it('keeps active and terminal Program keys at TTL=-1 by default', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const sequence = created.projection.program.sequence;

    const withdrawn = await service.command({
      programId,
      expectedSequence: sequence,
      clientMessageId: 'message-withdraw',
      actorRef: 'user:operator',
      originRef: 'thread:thread-f311:message:message-withdraw',
      action: {
        type: 'withdraw',
        decisionRef: { ownerFeatureId: 'F281', ownerStateRef: 'decision:withdraw-f311' },
      },
    });

    assert.equal(withdrawn.outcome, 'appended');
    assert.equal(withdrawn.projection.program.lifecycle, 'terminal');
    assert.equal(await redis.ttl(EvolutionProgramKeys.eventLog(programId)), -1);
    assert.equal(await redis.ttl(EvolutionProgramKeys.eventIds(programId)), -1);
    assert.equal(await redis.ttl(EvolutionProgramKeys.clientMessageIds(programId)), -1);
    assert.equal(await redis.ttl(EvolutionProgramKeys.programIndex(programId)), -1);
  });

  it('cancels an earlier forget TTL when the user explicitly switches to keep forever', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const withdrawn = await service.command({
      programId,
      expectedSequence: 1,
      clientMessageId: 'message-withdraw-before-retention-change',
      actorRef: 'user:operator',
      originRef: 'thread:thread-f311:message:withdraw-before-retention-change',
      action: { type: 'withdraw', decisionRef: { ownerFeatureId: 'F281', ownerStateRef: 'decision:withdraw' } },
    });
    const forgetting = await service.command({
      programId,
      expectedSequence: withdrawn.projection.program.sequence,
      clientMessageId: 'message-forget-after',
      actorRef: 'user:operator',
      originRef: 'thread:thread-f311:message:forget-after',
      action: {
        type: 'retention',
        mode: 'forget_after',
        ttlSeconds: 300,
        retentionActionRef: { ownerFeatureId: 'F281', ownerStateRef: 'retention:forget-after' },
      },
    });
    assert.ok((await redis.ttl(EvolutionProgramKeys.eventLog(programId))) > 0);

    const kept = await service.command({
      programId,
      expectedSequence: forgetting.projection.program.sequence,
      clientMessageId: 'message-keep-forever',
      actorRef: 'user:operator',
      originRef: 'thread:thread-f311:message:keep-forever',
      action: {
        type: 'retention',
        mode: 'keep_forever',
        retentionActionRef: { ownerFeatureId: 'F281', ownerStateRef: 'retention:keep-forever' },
      },
    });

    assert.equal(kept.projection.program.retention.mode, 'keep_forever');
    assert.equal(await redis.ttl(EvolutionProgramKeys.eventLog(programId)), -1);
    assert.equal(await redis.ttl(EvolutionProgramKeys.eventIds(programId)), -1);
    assert.equal(await redis.ttl(EvolutionProgramKeys.clientMessageIds(programId)), -1);
    assert.equal(await redis.ttl(EvolutionProgramKeys.programIndex(programId)), -1);
  });
});
