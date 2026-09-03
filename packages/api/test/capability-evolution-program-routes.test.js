import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f311-program-routes-test:';

describe('F311 Evolution Program permanent API', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let EvolutionProgramService;
  let EvolutionProgramServiceError;
  let RedisEvolutionProgramEventLog;
  let capabilityEvolutionProgramRoutes;
  let redis;
  let service;
  let eventLog;
  const apps = [];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F311EvolutionProgramRoutes');
    ({ RedisEvolutionProgramEventLog } = await import(
      '../dist/infrastructure/capability-evolution/program-event-log.js'
    ));
    ({ EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js'));
    ({ EvolutionProgramServiceError } = await import(
      '../dist/infrastructure/capability-evolution/program-command-contract.js'
    ));
    ({ capabilityEvolutionProgramRoutes } = await import('../dist/routes/capability-evolution-program-routes.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    eventLog = new RedisEvolutionProgramEventLog(redis);
    service = new EvolutionProgramService({
      eventLog,
      now: () => '2026-08-31T22:00:00.000Z',
    });
  });

  async function createApp(identity) {
    const app = Fastify();
    if (identity) {
      app.addHook('preHandler', (request, _reply, done) => {
        if (identity.kind === 'session') request.sessionUserId = identity.userId;
        else request.callbackPrincipal = identity.principal;
        done();
      });
    }
    await app.register(capabilityEvolutionProgramRoutes, { service });
    apps.push(app);
    return app;
  }

  const createBody = {
    targetRef: { ownerFeatureId: 'F202', ownerStateRef: 'skill:video-forge', version: 'v1' },
    clientMessageId: 'message-start-video-forge',
  };

  it('creates from target ref + client id and projects the same canonical truth to Workbench', async () => {
    const app = await createApp({ kind: 'session', userId: 'operator' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/capability-evolution/programs',
      payload: createBody,
    });

    assert.equal(created.statusCode, 201);
    const body = created.json();
    assert.equal(body.projection.program.workspaceId, 'user:operator');
    assert.equal(body.projection.program.lifecycle, 'active');
    assert.equal(body.projection.program.stage, 'constituting');
    assert.equal(body.surface.type, 'evolution-program');
    assert.equal(body.surface.objectRef.id, body.projection.program.programId);
    assert.ok(body.projection.blockers.some((blocker) => blocker.code === 'calibrator_missing'));
    assert.deepEqual(await service.get(body.projection.program.programId), body.projection);

    const listed = await app.inject({ method: 'GET', url: '/api/capability-evolution/programs' });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(
      listed.json().programs.map((entry) => entry.program.programId),
      [body.projection.program.programId],
    );
  });

  it('rejects caller-authored owner truth, lifecycle, stage, and certificates', async () => {
    const app = await createApp({ kind: 'session', userId: 'operator' });
    for (const smuggled of [
      { actorRef: 'cat:spoofed' },
      { workspaceId: 'user:other' },
      { lifecycle: 'terminal' },
      { stage: 'evaluating' },
      { certificates: { goal: { ownerFeatureId: 'F311', ownerStateRef: 'goal:fake' } } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/capability-evolution/programs',
        payload: { ...createBody, ...smuggled },
      });
      assert.equal(response.statusCode, 400);
    }
  });

  it('uses callback identity for the same create/read/command truth without identity fields in the body', async () => {
    const app = await createApp({
      kind: 'callback',
      principal: {
        kind: 'invocation',
        invocationId: 'inv-f311',
        threadId: 'thread-f311',
        userId: 'operator',
        catId: 'codex-sol',
      },
    });
    const created = await app.inject({ method: 'POST', url: '/api/callbacks/evolution-programs', payload: createBody });
    assert.equal(created.statusCode, 201);
    const programId = created.json().projection.program.programId;

    const paused = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${encodeURIComponent(programId)}/commands`,
      payload: {
        expectedSequence: 1,
        clientMessageId: 'message-pause-f311',
        action: { type: 'pause', reasonRef: { ownerFeatureId: 'F281', ownerStateRef: 'decision:pause-f311' } },
      },
    });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().projection.program.lifecycle, 'paused');

    const events = await eventLog.read(programId);
    assert.equal(events[0].actorRef, 'cat:codex-sol');
    assert.match(events[0].originRef, /^thread:thread-f311:invocation:inv-f311:/);
    assert.equal(events[1].actorRef, 'cat:codex-sol');
    const read = await app.inject({
      method: 'GET',
      url: `/api/callbacks/evolution-programs/${encodeURIComponent(programId)}`,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().program.lifecycle, 'paused');
  });

  it('fails closed without auth and does not reveal another workspace Program', async () => {
    const ownerApp = await createApp({ kind: 'session', userId: 'operator' });
    const created = await ownerApp.inject({
      method: 'POST',
      url: '/api/capability-evolution/programs',
      payload: createBody,
    });
    const programId = created.json().projection.program.programId;
    const otherApp = await createApp({ kind: 'session', userId: 'other' });
    const hidden = await otherApp.inject({
      method: 'GET',
      url: `/api/capability-evolution/programs/${encodeURIComponent(programId)}`,
    });
    assert.equal(hidden.statusCode, 404);

    const unauthenticated = await createApp();
    assert.equal(
      (await unauthenticated.inject({ method: 'GET', url: '/api/capability-evolution/programs' })).statusCode,
      401,
    );

    const malformed = await ownerApp.inject({
      method: 'GET',
      url: '/api/capability-evolution/programs/not-a-program',
    });
    assert.equal(malformed.statusCode, 400);
  });
  it('rejects generic GC commands because collection is only reachable through explicit retention or forget', async () => {
    const app = await createApp({ kind: 'session', userId: 'operator' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/capability-evolution/programs',
      payload: createBody,
    });
    const programId = created.json().projection.program.programId;
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${encodeURIComponent(programId)}/commands`,
      payload: {
        expectedSequence: 1,
        clientMessageId: 'message-generic-gc',
        action: { type: 'garbage_collect' },
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_input');
  });

  it('returns the latest canonical projection when a command arrives with a stale sequence', async () => {
    const app = await createApp({ kind: 'session', userId: 'operator' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/capability-evolution/programs',
      payload: createBody,
    });
    const programId = created.json().projection.program.programId;
    const paused = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${encodeURIComponent(programId)}/commands`,
      payload: {
        expectedSequence: 1,
        clientMessageId: 'message-external-pause',
        action: { type: 'pause', reasonRef: { ownerFeatureId: 'F311', ownerStateRef: 'decision:external-pause' } },
      },
    });
    assert.equal(paused.statusCode, 200);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${encodeURIComponent(programId)}/commands`,
      payload: {
        expectedSequence: 1,
        clientMessageId: 'message-stale-pause',
        action: { type: 'pause', reasonRef: { ownerFeatureId: 'F311', ownerStateRef: 'decision:stale-pause' } },
      },
    });

    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().outcome, 'conflict');
    assert.equal(stale.json().actualSequence, 2);
    assert.equal(stale.json().projection.program.lifecycle, 'paused');
    assert.equal(stale.json().projection.program.sequence, 2);

    const staleForget = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${encodeURIComponent(programId)}/commands`,
      payload: {
        expectedSequence: 1,
        clientMessageId: 'message-stale-forget',
        action: {
          type: 'forget',
          ttlSeconds: 60,
          decisionRef: { ownerFeatureId: 'F311', ownerStateRef: 'decision:stale-forget' },
          retentionActionRef: { ownerFeatureId: 'F311', ownerStateRef: 'retention:stale-forget' },
        },
      },
    });
    assert.equal(staleForget.statusCode, 409);
    assert.equal(staleForget.json().outcome, 'conflict');
    assert.equal(staleForget.json().actualSequence, 2);
    assert.equal(staleForget.json().projection.program.lifecycle, 'paused');
    assert.equal(await eventLog.ttl(programId), -1);
  });

  it('maps list service failures through the same typed error contract as other handlers', async () => {
    service = {
      list: async () => {
        throw new EvolutionProgramServiceError('invalid_command', 'list projection unavailable');
      },
    };
    const app = await createApp({ kind: 'session', userId: 'operator' });
    const response = await app.inject({ method: 'GET', url: '/api/capability-evolution/programs' });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: 'invalid_command', detail: 'list projection unavailable' });
  });
});
