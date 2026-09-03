import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f311-program-adversarial-test:';

describe('F311 Evolution Program adversarial persistence', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let EvolutionProgramService;
  let EvolutionProgramKeys;
  let RedisEvolutionProgramEventLog;
  let projectEvolutionProgram;
  let redis;
  let eventLog;
  let service;
  let tick;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F311EvolutionProgramAdversarial');
    ({ EvolutionProgramKeys, RedisEvolutionProgramEventLog } = await import(
      '../dist/infrastructure/capability-evolution/program-event-log.js'
    ));
    ({ EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js'));
    ({ projectEvolutionProgram } = await import('../dist/infrastructure/capability-evolution/program-projection.js'));
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
      now: () => new Date(Date.parse('2026-08-31T21:00:00.000Z') + tick++ * 1_000).toISOString(),
    });
  });

  async function createProgram() {
    return service.create({
      workspaceId: 'user:operator',
      targetRef: { ownerFeatureId: 'F202', ownerStateRef: 'skill:video-forge', version: 'v1' },
      clientMessageId: 'message-create-adversarial',
      actorRef: 'cat:codex-sol',
      originRef: 'thread:thread-f311:message:message-create-adversarial',
    });
  }

  it('checks exact duplicate identities before stale sequence conflicts', async () => {
    const first = await createProgram();
    const retry = await createProgram();

    assert.equal(first.outcome, 'appended');
    assert.equal(retry.outcome, 'duplicate');
    assert.deepEqual(retry.projection, first.projection);
  });

  it('rejects identity collisions with different content', async () => {
    await createProgram();
    await assert.rejects(
      () =>
        service.create({
          workspaceId: 'user:operator',
          targetRef: { ownerFeatureId: 'F208', ownerStateRef: 'dossier:codex-sol' },
          clientMessageId: 'message-create-adversarial',
          actorRef: 'cat:codex-sol',
          originRef: 'thread:thread-f311:message:message-create-adversarial',
        }),
      (error) => error?.code === 'idempotency_collision',
    );
  });

  it('lets exactly one concurrent expected-sequence command win', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const expectedSequence = created.projection.program.sequence;
    const command = (suffix) =>
      service.command({
        programId,
        expectedSequence,
        clientMessageId: `message-pause-${suffix}`,
        actorRef: 'user:operator',
        originRef: `thread:thread-f311:message:message-pause-${suffix}`,
        action: {
          type: 'pause',
          reasonRef: { ownerFeatureId: 'F281', ownerStateRef: `decision:pause-${suffix}` },
        },
      });

    const results = await Promise.all([command('a'), command('b')]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['appended', 'conflict']);
    assert.equal((await service.get(programId)).program.sequence, expectedSequence + 1);
  });

  it('atomically withdraws an active Program before recording forget retention', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const forget = {
      programId,
      expectedSequence: created.projection.program.sequence,
      clientMessageId: 'message-forget-active',
      actorRef: 'user:operator',
      originRef: 'thread:thread-f311:message:message-forget-active',
      action: {
        type: 'forget',
        ttlSeconds: 3_600,
        decisionRef: { ownerFeatureId: 'F281', ownerStateRef: 'decision:forget-active' },
        retentionActionRef: { ownerFeatureId: 'F281', ownerStateRef: 'retention:forget-active' },
      },
    };
    const result = await service.command(forget);
    const retry = await service.command(forget);

    assert.equal(result.outcome, 'appended');
    assert.equal(retry.outcome, 'duplicate');
    assert.deepEqual(retry.projection, result.projection);
    assert.equal(result.projection.program.lifecycle, 'terminal');
    assert.equal(result.projection.program.terminalDisposition, 'withdrawn');
    assert.equal(result.projection.program.retention.mode, 'forget_after');
    assert.equal(result.projection.program.sequence, created.projection.program.sequence + 2);
    assert.ok((await eventLog.ttl(programId)) > 0);
    const types = (await eventLog.read(programId)).map((entry) => entry.event.type);
    assert.deepEqual(types.slice(-2), ['program_withdrawn', 'retention_opted_in']);
  });

  it('never exposes an active+TTL crash window under concurrent reads', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const forgetPromise = service.command({
      programId,
      expectedSequence: created.projection.program.sequence,
      clientMessageId: 'message-forget-race',
      actorRef: 'user:operator',
      originRef: 'thread:thread-f311:message:message-forget-race',
      action: {
        type: 'forget',
        ttlSeconds: 3_600,
        decisionRef: { ownerFeatureId: 'F281', ownerStateRef: 'decision:forget-race' },
        retentionActionRef: { ownerFeatureId: 'F281', ownerStateRef: 'retention:forget-race' },
      },
    });
    const observations = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const snapshot = await eventLog.readWithTtl(programId);
        return { lifecycle: projectEvolutionProgram(snapshot.events).program.lifecycle, ttl: snapshot.ttl };
      }),
    );
    await forgetPromise;

    assert.equal(
      observations.some((observation) => observation.lifecycle === 'active' && observation.ttl > 0),
      false,
    );
  });
  it('expires Program tombstones and index with the log, then permits the same message to create again', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    await service.command({
      programId,
      expectedSequence: created.projection.program.sequence,
      clientMessageId: 'message-forget-before-recreate',
      actorRef: 'user:operator',
      originRef: 'thread:thread-f311:message:message-forget-before-recreate',
      action: {
        type: 'forget',
        ttlSeconds: 3_600,
        decisionRef: { ownerFeatureId: 'F281', ownerStateRef: 'decision:forget-before-recreate' },
        retentionActionRef: { ownerFeatureId: 'F281', ownerStateRef: 'retention:forget-before-recreate' },
      },
    });

    const expiringKeys = [
      EvolutionProgramKeys.eventLog(programId),
      EvolutionProgramKeys.eventIds(programId),
      EvolutionProgramKeys.clientMessageIds(programId),
      EvolutionProgramKeys.programIndex(programId),
    ];
    for (const key of expiringKeys) assert.ok((await redis.ttl(key)) > 0);

    await redis.del(...expiringKeys);
    assert.deepEqual(await eventLog.listProgramIds('user:operator'), []);
    const recreated = await createProgram();
    assert.equal(recreated.outcome, 'appended');
    assert.equal(recreated.projection.program.programId, programId);
  });
});
