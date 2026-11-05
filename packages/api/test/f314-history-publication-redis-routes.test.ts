import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { ProgramAdapterRegistry } from '../src/infrastructure/capability-evolution/adapters/program-adapter-registry.js';
import { HarnessHistoryPublicationOwner } from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-owner.js';
import {
  harnessHistoryPublicationKeys,
  RedisHarnessHistoryPublicationStore,
} from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-redis.js';
import { HarnessHistoryPublicationService } from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-service.js';
import { createRequestReviewOwnerAdapter } from '../src/infrastructure/capability-evolution/adapters/request-review/request-review-owner-adapter.js';
import { RedisEvolutionProgramEventLog } from '../src/infrastructure/capability-evolution/program-event-log.js';
import { EvolutionProgramService } from '../src/infrastructure/capability-evolution/program-service.js';
import { capabilityEvolutionProgramRoutes } from '../src/routes/capability-evolution-program-routes.js';
import { harnessHistoryRoutes } from '../src/routes/harness-history-routes.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const archive = JSON.parse(
  readFileSync(
    new URL('../../shared/src/__tests__/fixtures/f314-history-publication-contract.json', import.meta.url),
    'utf8',
  ),
);
const a = 'a'.repeat(40),
  b = 'b'.repeat(40);

test(
  'real callback publication survives store reconstruction, stays persistent, and never mutates Program state',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F314HistoryPublication');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f314-history-test:${process.pid}:` });
    const app = Fastify();
    try {
      await cleanupClientKeyspace(redis);
      const next = structuredClone(archive);
      next.story.nodes[0].summary = '新发布的历史正文';
      let runtimeHead = a;
      const source = {
        baseline: async () => runtimeHead,
        read: async (revision: string) => (revision === b ? next : archive),
        acquire: async () => next,
        ignoredFieldPaths: async (revision: string) => (revision === b ? ['/story/steps/0/futurePresentation'] : []),
      };
      const store = new RedisHarnessHistoryPublicationStore(redis);
      const owner = new HarnessHistoryPublicationOwner({ store, source });
      const registry = new ProgramAdapterRegistry();
      registry.register(
        createRequestReviewOwnerAdapter({
          historyReader: owner.read.bind(owner),
          port: {
            gitHeadOid: async () => a,
            gitBlobOidAt: async () => a,
            readSkillFileAt: async () => '',
            readMutableAcceptedSourceAt: async () => '',
            listFileHistoryAt: async () => [],
            readHarnessLineageAt: async () => archive,
          },
        }),
      );
      const eventLog = new RedisEvolutionProgramEventLog(redis);
      const programs = new EvolutionProgramService({ eventLog });
      const threadStore = new ThreadStore();
      const thread = await threadStore.create('operator', 'history publication fixture', '/repo');
      const invocations = new InvocationRegistry();
      const catId = createCatId('codex-astra');
      const credentials = await invocations.create(
        'operator',
        catId,
        thread.id,
        undefined,
        undefined,
        undefined,
        'source-message',
      );
      const headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
      const created = await programs.create({
        workspaceId: 'user:operator',
        targetRef: { ownerFeatureId: 'F100', ownerStateRef: 'capability:development-process-harness-effectiveness' },
        clientMessageId: 'history-program',
        actorRef: 'cat:codex-astra',
        originRef: `thread:${thread.id}`,
      });
      const id = created.projection.program.programId;
      const initialProgram = await eventLog.read(id);
      const service = new HarnessHistoryPublicationService({
        owner,
        service: programs,
        adapterRegistry: registry,
        dependencies: { invocationReader: invocations, threadStore },
      });
      app.addHook('preHandler', async (request) => {
        if (request.headers['x-fixture-session'])
          Object.assign(request, { sessionUserId: request.headers['x-fixture-session'] });
      });
      await app.register(harnessHistoryRoutes, { service, callbackRegistry: invocations });
      await app.register(capabilityEvolutionProgramRoutes, {
        service: programs,
        callbackRegistry: invocations,
        adapterRegistry: registry,
      });
      const url = `/api/callbacks/harness-history/programs/${encodeURIComponent(id)}`;
      const exploration = `/api/capability-evolution/programs/${encodeURIComponent(id)}/exploration`;
      const command = {
        action: 'publish',
        sourceRevision: b,
        expectedRevision: 0,
        clientMessageId: 'publish-one',
        reason: '新增后续结果',
      };
      assert.equal(
        (await app.inject({ method: 'POST', url: `${url}/publications`, payload: command })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${url}/publications`,
            headers: { 'x-fixture-session': 'operator' },
            payload: command,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${url}/publications`,
            headers,
            payload: { ...command, actorRef: 'cat:other' },
          })
        ).statusCode,
        400,
      );
      assert.equal((await store.read(id)).revision, 0);
      const initial = await app.inject({ url: exploration, headers });
      assert.equal(initial.statusCode, 200, initial.body);
      const pinned = initial.json();
      runtimeHead = b;
      const afterDeployment = new HarnessHistoryPublicationOwner({
        store: new RedisHarnessHistoryPublicationStore(redis),
        source,
      });
      const oldBeforePublication = await afterDeployment.read({
        programRef: { ownerFeatureId: 'F311', ownerStateRef: id },
        objectRef: created.projection.program.objectRef,
        selectedSourceRef: pinned.sourceRef,
      });
      assert.equal(oldBeforePublication.status, 'resolved');
      assert.deepEqual((await store.read(id)).attempts, [], 'first reading is not a publication attempt');
      assert.equal((await store.read(id)).baselineSourceRevision, a);
      assert.equal(await redis.ttl(harnessHistoryPublicationKeys(id).metadata), -1);
      const writes = await Promise.all(
        ['publish-one', 'publish-two'].map((clientMessageId) =>
          app.inject({ method: 'POST', url: `${url}/publications`, headers, payload: { ...command, clientMessageId } }),
        ),
      );
      assert.deepEqual(writes.map((response) => response.statusCode).sort(), [201, 409]);
      const published = writes.find((response) => response.statusCode === 201);
      assert.ok(published);
      const written = published.json();
      assert.equal(written.attempt.actorRef, 'cat:codex-astra');
      assert.match(written.attempt.originRef, /:message:source-message$/);
      assert.deepEqual(written.attempt.ignoredFieldPaths, ['/story/steps/0/futurePresentation']);
      const current = await app.inject({ url: exploration, headers });
      assert.equal(current.statusCode, 200, current.body);
      assert.equal(current.json().nodes[0].summary, next.story.nodes[0].summary);
      const old = await app.inject({
        url: `${exploration}?selectedSourceRef=${encodeURIComponent(JSON.stringify(pinned.sourceRef))}`,
        headers,
      });
      assert.equal(old.statusCode, 200, old.body);
      assert.equal(old.json().nodes[0].summary, pinned.nodes[0].summary);
      const rebuilt = new HarnessHistoryPublicationOwner({
        store: new RedisHarnessHistoryPublicationStore(redis),
        source,
      });
      const status = await rebuilt.status({
        programRef: { ownerFeatureId: 'F311', ownerStateRef: id },
        objectRef: created.projection.program.objectRef,
      });
      assert.equal(status.current.sourceRevision, b);
      assert.equal(status.current.revision, 1);
      assert.deepEqual(status.attempts[0]?.ignoredFieldPaths, ['/story/steps/0/futurePresentation']);
      for (const key of Object.values(harnessHistoryPublicationKeys(id))) assert.equal(await redis.ttl(key), -1);
      const duplicate = await app.inject({
        method: 'POST',
        url: `${url}/publications`,
        headers,
        payload: { ...command, clientMessageId: written.attempt.clientMessageId },
      });
      assert.equal(duplicate.statusCode, 200);
      assert.equal(duplicate.json().outcome, 'duplicate');
      const collision = await app.inject({
        method: 'POST',
        url: `${url}/publications`,
        headers,
        payload: { ...command, clientMessageId: written.attempt.clientMessageId, reason: 'changed' },
      });
      assert.equal(collision.statusCode, 409);
      const restore = await app.inject({
        method: 'POST',
        url: `${url}/publications`,
        headers,
        payload: {
          action: 'restore',
          restoreRevision: 0,
          expectedRevision: 1,
          clientMessageId: 'restore',
          reason: '恢复完整旧稿',
        },
      });
      assert.equal(restore.statusCode, 201);
      assert.equal(restore.json().attempt.revision, 2);
      const foreign = await invocations.create('other', catId, thread.id);
      assert.equal(
        (
          await app.inject({
            url,
            headers: { 'x-invocation-id': foreign.invocationId, 'x-callback-token': foreign.callbackToken },
          })
        ).statusCode,
        404,
      );
      await assert.rejects(
        () =>
          service.publish(
            id,
            {
              kind: 'invocation',
              userId: 'operator',
              catId: createCatId('codex-sol'),
              threadId: thread.id,
              invocationId: credentials.invocationId,
            },
            { ...command, action: 'publish' },
          ),
        { code: 'history_actor_invalid' },
      );
      await invocations.commitTerminal({
        invocationId: credentials.invocationId,
        disposition: 'completed',
        endedAt: Date.now(),
        endReason: 'test complete',
      });
      const closed = await app.inject({
        method: 'POST',
        url: `${url}/publications`,
        headers,
        payload: { ...command, expectedRevision: 2, clientMessageId: 'closed' },
      });
      assert.equal(closed.statusCode, 401, closed.body);
      assert.equal((await store.read(id)).revision, 2);
      assert.deepEqual(
        await eventLog.read(id),
        initialProgram,
        'history publication must never become adoption or Program mutation',
      );
    } finally {
      await app.close();
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
