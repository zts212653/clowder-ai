/**
 * F167 Phase R — RedisMessageStore parity for same-invocation outbound coordination
 * terminal binding (roof620 positive + negative 409 + replay safety).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import Redis from 'ioredis';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;
const options = { skip: redisIsolationSkipReason(redisUrl) };

async function connectIsolatedRedis(t) {
  assertRedisIsolationOrThrow(redisUrl, 'f167-outbound-coord-terminal-redis');
  const redis = new Redis(redisUrl, {
    keyPrefix: `f167-outbound:${randomUUID()}:`,
    maxRetriesPerRequest: 1,
  });
  await redis.ping();
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  return redis;
}

test(
  'RedisMessageStore parity: roof620 outbound B closes + replays cleanly while forged/cross-invocation/cross-subject/stale reject 409',
  options,
  async (t) => {
    const redis = await connectIsolatedRedis(t);
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryDispatchProposalStore } = await import(
      '../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { RedisQueueLedgerStore } = await import(
      '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js'
    );
    const { buildCallbackPostMessageIdempotencyKey } = await import(
      '../dist/domains/cats/services/agents/routing/callback-message-idempotency.js'
    );
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    const registry = new InvocationRegistry();
    const messageStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const threadStore = new ThreadStore();
    const invocationQueue = new InvocationQueue(new RedisQueueLedgerStore(redis));
    const records = [];
    const app = Fastify();
    t.after(async () => {
      await app.close();
    });

    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: {
        async *routeExecution() {
          yield* [];
        },
        getExecutions() {
          return [];
        },
      },
      invocationRecordStore: {
        create(input) {
          const id = `inv-${records.length}`;
          records.push({ id, ...input });
          return { outcome: 'created', invocationId: id };
        },
        update() {},
        get() {
          return null;
        },
      },
      dispatchProposalStore: new InMemoryDispatchProposalStore(),
      invocationQueue,
      queueProcessor: { requestDrain() {} },
    });

    async function post({ auth, threadId, content, targetCat, coordination, clientMessageId }) {
      return app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: {
          'x-invocation-id': auth.invocationId,
          'x-callback-token': auth.callbackToken,
        },
        payload: {
          ...(threadId ? { threadId } : {}),
          content,
          ...(targetCat ? { targetCats: [targetCat] } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(coordination ? { coordination } : {}),
        },
      });
    }

    const threadA = await threadStore.create('user-1', 'Source A');
    const threadWorker = await threadStore.create('user-1', 'Worker');
    const threadRoofB = await threadStore.create('user-1', 'Roof B');
    for (const th of [threadA, threadWorker, threadRoofB]) {
      await threadStore.addParticipants(th.id, ['opus', 'codex', 'sonnet']);
    }

    const prevAuth = await registry.create('user-1', 'codex', threadWorker.id);
    const prevClaim = await post({
      auth: prevAuth,
      threadId: threadRoofB.id,
      content: 'Prev active',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: 'file:prev' },
    });
    const prevCoordId = prevClaim.json().coordination.id;

    const authA = await registry.create('user-1', 'opus', threadA.id);
    const inboundA = await post({
      auth: authA,
      threadId: threadWorker.id,
      content: 'Inbound A',
      targetCat: 'codex',
      coordination: { phase: 'active', subjectRef: 'artifact:a' },
    });
    const coordA = inboundA.json().coordination.id;

    const workerAuth = await registry.create('user-1', 'codex', threadWorker.id, undefined, inboundA.json().messageId);
    const claimB = await post({
      auth: workerAuth,
      threadId: threadRoofB.id,
      content: 'Claim roof620',
      targetCat: 'sonnet',
      coordination: { phase: 'active', subjectRef: 'file:roof620' },
      clientMessageId: 'redis-claim-b',
    });
    assert.equal(claimB.statusCode, 200);
    const coordB = claimB.json().coordination.id;

    // Cross-invocation and wrong-subject must 409 without claiming idempotency in Redis.
    for (const [label, coordination, expectedKind] of [
      [
        'forged',
        { phase: 'terminal', id: 'coord-forged-redis', subjectRef: 'file:roof620' },
        'coordination_id_conflict',
      ],
      ['cross-inv', { phase: 'terminal', id: prevCoordId, subjectRef: 'file:prev' }, 'coordination_id_conflict'],
      ['wrong-subj', { phase: 'terminal', id: coordB, subjectRef: 'file:other' }, 'coordination_subject_conflict'],
    ]) {
      const key = `redis-neg-${label}`;
      const res = await post({
        auth: workerAuth,
        threadId: threadRoofB.id,
        content: `Neg ${label}`,
        targetCat: 'sonnet',
        coordination,
        clientMessageId: key,
      });
      assert.equal(res.statusCode, 409, `${label}: ${res.body}`);
      assert.equal(res.json().kind, expectedKind);
      assert.equal(
        await messageStore.getByIdempotencyKey(
          'user-1',
          threadRoofB.id,
          buildCallbackPostMessageIdempotencyKey('codex', key),
        ),
        null,
      );
    }

    // Exact release of B succeeds and same-key replay returns duplicate with coordination.
    const releaseB = await post({
      auth: workerAuth,
      threadId: threadRoofB.id,
      content: 'Release roof620',
      targetCat: 'sonnet',
      coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:roof620' },
      clientMessageId: 'redis-release-b',
    });
    assert.equal(releaseB.statusCode, 200, releaseB.body);
    assert.equal(releaseB.json().coordination.phase, 'terminal');
    assert.equal(releaseB.json().coordination.hop, 1);

    const replayB = await post({
      auth: workerAuth,
      threadId: threadRoofB.id,
      content: 'Release roof620',
      targetCat: 'sonnet',
      coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:roof620' },
      clientMessageId: 'redis-release-b',
    });
    assert.equal(replayB.statusCode, 200, replayB.body);
    assert.equal(replayB.json().status, 'duplicate');
    assert.deepEqual(replayB.json().coordination, releaseB.json().coordination);

    // Second non-idempotent close of B fails closed with 409; incoming A still closes cleanly.
    const staleB = await post({
      auth: workerAuth,
      threadId: threadRoofB.id,
      content: 'Second close B',
      targetCat: 'sonnet',
      coordination: { phase: 'terminal', id: coordB, subjectRef: 'file:roof620' },
      clientMessageId: 'redis-stale-b',
    });
    assert.equal(staleB.statusCode, 409);

    const releaseA = await post({
      auth: workerAuth,
      threadId: threadA.id,
      content: 'Complete A',
      targetCat: 'opus',
      coordination: { phase: 'terminal', id: coordA, subjectRef: 'artifact:a' },
      clientMessageId: 'redis-release-a',
    });
    assert.equal(releaseA.statusCode, 200, releaseA.body);
    assert.equal(releaseA.json().coordination.id, coordA);
    assert.equal(releaseA.json().coordination.phase, 'terminal');
  },
);
