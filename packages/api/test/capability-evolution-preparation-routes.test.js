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
const TEST_KEY_PREFIX = 'f311-preparation-routes-test:';

describe('F311 preparation callback routes', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let EvolutionProgramService;
  let EvolutionProgramPreparationService;
  let RedisEvolutionProgramEventLog;
  let MessageStore;
  let ThreadStore;
  let capabilityEvolutionProgramRoutes;
  let redis;
  let eventLog;
  let messageStore;
  let threadStore;
  let thread;
  let records;
  let service;
  let programService;
  let published;
  const apps = [];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F311PreparationRoutes');
    ({ RedisEvolutionProgramEventLog } = await import(
      '../dist/infrastructure/capability-evolution/program-event-log.js'
    ));
    ({ EvolutionProgramService } = await import('../dist/infrastructure/capability-evolution/program-service.js'));
    ({ EvolutionProgramPreparationService } = await import(
      '../dist/infrastructure/capability-evolution/program-preparation-service.js'
    ));
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
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
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    thread = await threadStore.create('operator', 'Preparation route', '/repo');
    records = new Map([
      [
        'inv-route',
        { invocationId: 'inv-route', userId: 'operator', catId: 'codex-sol', threadId: thread.id, state: 'active' },
      ],
    ]);
    published = [];
    programService = new EvolutionProgramService({ eventLog });
    service = new EvolutionProgramPreparationService({
      eventLog,
      projectProgram: (events) => programService.project(events),
      now: () => '2026-09-09T09:00:00.000Z',
      dependencies: {
        messageStore,
        threadStore,
        invocationReader: { peekRecord: async (id) => records.get(id) ?? null },
        publishMessage: (message) => published.push(message),
      },
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
    await app.register(capabilityEvolutionProgramRoutes, { service: programService, preparationService: service });
    apps.push(app);
    return app;
  }

  async function createProgram() {
    return programService.create({
      workspaceId: 'user:operator',
      targetRef: { ownerFeatureId: 'F311', ownerStateRef: 'capability:pm-agent' },
      clientMessageId: 'route-create',
      actorRef: 'cat:codex-sol',
      originRef: `thread:${thread.id}:invocation:inv-route:message:route-create`,
    });
  }

  const callback = {
    kind: 'callback',
    principal: {
      kind: 'invocation',
      invocationId: 'inv-route',
      userId: 'operator',
      catId: 'codex-sol',
      get threadId() {
        return thread.id;
      },
    },
  };

  const objectBody = {
    kind: 'object_map',
    goalStatement: '让 PM Agent 专业推进项目，只在必要时请人介入',
    summary: 'The cause and intervention remain open.',
    items: [
      {
        itemId: 'model',
        label: 'Model adaptation',
        scope: 'Current PM runtime.',
        why: 'Model fit is one candidate, not the assumed answer.',
        modifiability: { state: 'unknown', reason: 'Ownership has not been checked.', basisRefs: [] },
        sourceRefs: [],
        nextAction: 'Resolve the runtime owner and exact version.',
      },
    ],
    unknowns: ['No customer environment is connected.'],
    nextAction: 'Inspect all candidate owners.',
  };

  it('accepts only invocation-auth writes and includes preparation only on exact GET', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const url = `/api/callbacks/evolution-programs/${encodeURIComponent(programId)}/preparation`;
    const app = await createApp(callback);

    const begin = await app.inject({
      method: 'POST',
      url: `${url}/work`,
      payload: {
        expectedSequence: 1,
        clientMessageId: 'route-begin',
        section: 'object_map',
        itemId: 'model',
        focus: 'Check the model owner and version.',
        expectedCurrentSubmissionRef: null,
      },
    });
    assert.equal(begin.statusCode, 200);
    assert.equal(begin.json().projection.preparation.sections.object_map.activities[0].state, 'active');

    const submit = await app.inject({
      method: 'POST',
      url: `${url}/submissions`,
      payload: {
        expectedSequence: 2,
        clientMessageId: 'route-submit',
        section: 'object_map',
        title: '可进化对象',
        expectedCurrentSubmissionRef: null,
        dependsOn: [],
        body: objectBody,
      },
    });
    assert.equal(submit.statusCode, 201);
    assert.equal(submit.json().projection.preparation.sections.object_map.current.status, 'submitted');
    assert.equal(published.length, 1);
    assert.equal(published[0].id, submit.json().projection.preparation.sections.object_map.current.messageId);

    const exact = await app.inject({ method: 'GET', url: `/api/callbacks/evolution-programs/${programId}` });
    assert.equal(exact.statusCode, 200);
    assert.equal(exact.json().preparation.sections.object_map.current.submission.body.kind, 'object_map');
    const list = await app.inject({ method: 'GET', url: '/api/callbacks/evolution-programs' });
    assert.equal(list.statusCode, 200);
    assert.equal('preparation' in list.json().programs[0], false);
  });

  it('rejects browser, agent-key, cross-workspace and caller-authored identity fields without side effects', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const callbackUrl = `/api/callbacks/evolution-programs/${programId}/preparation/work`;
    const browserUrl = `/api/capability-evolution/programs/${programId}/preparation/work`;
    const payload = {
      expectedSequence: 1,
      clientMessageId: 'forbidden-begin',
      section: 'object_map',
      focus: 'Do work.',
      expectedCurrentSubmissionRef: null,
    };

    const browser = await createApp({ kind: 'session', userId: 'operator' });
    assert.equal((await browser.inject({ method: 'POST', url: browserUrl, payload })).statusCode, 403);
    const agentKey = await createApp({
      kind: 'callback',
      principal: { kind: 'agent_key', agentKeyId: 'key', userId: 'operator', catId: 'codex-sol', scope: 'user-bound' },
    });
    assert.equal((await agentKey.inject({ method: 'POST', url: callbackUrl, payload })).statusCode, 403);
    const stranger = await createApp({
      kind: 'callback',
      principal: { ...callback.principal, userId: 'other' },
    });
    assert.equal((await stranger.inject({ method: 'POST', url: callbackUrl, payload })).statusCode, 404);
    const owner = await createApp(callback);
    assert.equal(
      (
        await owner.inject({
          method: 'POST',
          url: callbackUrl,
          payload: { ...payload, actorRef: 'cat:spoof', workspaceId: 'user:other', invocationId: 'spoof' },
        })
      ).statusCode,
      400,
    );
    assert.equal((await eventLog.read(programId)).length, 1);
    assert.equal(messageStore.getRecent(10, 'operator').length, 0);
  });

  it('returns typed revision conflicts and rejects section/body mismatch and unknown fields', async () => {
    const created = await createProgram();
    const programId = created.projection.program.programId;
    const app = await createApp(callback);
    const url = `/api/callbacks/evolution-programs/${programId}/preparation/submissions`;
    const valid = {
      expectedSequence: 1,
      clientMessageId: 'first-submit',
      section: 'object_map',
      title: '可进化对象',
      expectedCurrentSubmissionRef: null,
      dependsOn: [],
      body: objectBody,
    };
    const first = await app.inject({ method: 'POST', url, payload: valid });
    assert.equal(first.statusCode, 201);
    const stale = await app.inject({ method: 'POST', url, payload: { ...valid, clientMessageId: 'stale-submit' } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'preparation_revision_conflict');
    const mismatched = await app.inject({
      method: 'POST',
      url,
      payload: { ...valid, clientMessageId: 'bad-kind', section: 'measurement_plan' },
    });
    assert.equal(mismatched.statusCode, 400);
    const smuggled = await app.inject({
      method: 'POST',
      url,
      payload: { ...valid, clientMessageId: 'smuggled', revision: `sha256:${'a'.repeat(64)}` },
    });
    assert.equal(smuggled.statusCode, 400);
  });
});
