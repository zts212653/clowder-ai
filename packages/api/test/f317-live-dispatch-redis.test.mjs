import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

for (const carrier of ['live', 'ordinary'])
  test(
    `Redis ${carrier} event-before-receipt crash recovers from canonical stores without another dispatch terminal`,
    { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
    async () => {
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 dispatch recovery');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
      const { RedisTurnExecutionStore } = await import(
        '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js'
      );
      const { RedisBallCustodyEventLog } = await import('../dist/domains/ball-custody/BallCustodyEventLog.js');
      const { RedisBallCustodyProjectionStore } = await import(
        '../dist/domains/ball-custody/BallCustodyProjectionStore.js'
      );
      const { BallCustodyProjector } = await import('../dist/domains/ball-custody/BallCustodyProjector.js');
      const { BallCustodyIngest } = await import('../dist/domains/ball-custody/BallCustodyIngest.js');
      const { A2ADispatchDispositionService } = await import(
        '../dist/domains/ball-custody/A2ADispatchDispositionService.js'
      );
      const { DispatchReceiptService } = await import('../dist/domains/ball-custody/DispatchReceiptService.js');
      const { buildHandedEvent } = await import('../dist/domains/ball-custody/ball-custody-events.js');
      const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
      const { QueuedMessageCustodyCoordinator, createInitialQueuedMessageCustody } = await import(
        '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
      );
      const { getQueueReadEvidence, recordLiveFullReadEvidence } = await import(
        '../dist/domains/cats/services/agents/invocation/QueueReadEvidence.js'
      );
      const { DispatchAdoptionAuthority } = await import('../dist/domains/ball-custody/DispatchAdoptionAuthority.js');
      const { TurnCustodyAdoptionRegistry } = await import(
        '../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js'
      );
      const adoptions = new TurnCustodyAdoptionRegistry();
      let unregister;
      const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f317-dispatch:${randomUUID()}:` });
      try {
        const messages = new RedisMessageStore(redis);
        const executions = new RedisTurnExecutionStore(redis);
        const events = new RedisBallCustodyEventLog(redis);
        const projections = new RedisBallCustodyProjectionStore(redis);
        const projector = new BallCustodyProjector(events, projections);
        const ingest = new BallCustodyIngest(events, projector);
        const queue = new InvocationQueue();
        const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
        const scope = {
          threadId: 'home',
          userId: 'owner',
          catId: 'codex-sol',
          invocationId: 'live-child',
          parentInvocationId: 'live-parent',
        };
        const at = Date.now() - 10_000;
        const source = await messages.append({
          userId: 'owner',
          threadId: 'home',
          catId: 'opus',
          content: 'synthetic dispatch',
          mentions: ['codex-sol'],
          timestamp: at,
          deliveryStatus: 'queued',
        });
        await ingest.record(
          buildHandedEvent({
            threadId: 'home',
            fromCatId: 'opus',
            toCatId: 'codex-sol',
            messageId: source.id,
            at: at + 1,
          }),
        );
        const admitted = queue.enqueue({
          threadId: 'home',
          userId: 'owner',
          messageId: source.id,
          content: source.content,
          source: 'agent',
          targetCats: ['codex-sol'],
          intent: 'execute',
          ownerAuthProvenance: 'strict',
        });
        assert.equal(admitted.outcome, 'enqueued');
        await messages.initializeQueueCustody(source.id, createInitialQueuedMessageCustody(admitted.entry));
        queue.markQueuedSeen('home', 'owner', admitted.entry.id, 'codex-sol', scope.invocationId, at + 2);
        await coordinator.persistEntry(queue.getEntrySnapshot('home', 'owner', admitted.entry.id));
        await executions.createRunning({
          ...scope,
          executionKind: 'ordinary',
          ...(carrier === 'live' ? { queueCompletionPolicy: 'explicit_source' } : {}),
          startedAt: at,
        });
        await recordLiveFullReadEvidence(
          messages,
          executions,
          { ...scope, messageIds: [source.id], seenAt: at + 3 },
          events,
        );
        unregister = adoptions.register(scope.invocationId, async () => {});
        const service = new A2ADispatchDispositionService({
          ...(carrier === 'ordinary'
            ? { adoptionAuthority: new DispatchAdoptionAuthority({ executions, messages, adoptions }) }
            : {}),
          registry: { isLatest: async () => true },
          messageStore: messages,
          ballCustodyEventLog: events,
          ballCustodyProjectionStore: projections,
          ballCustody: ingest,
          isLiveCarrierInvocation: async () => true,
          getReadEvidenceForMessage: (query) => getQueueReadEvidence(messages, query),
          projectAdoptedDisposition: async () => {
            throw new Error('synthetic crash after event');
          },
        });
        await assert.rejects(service.completeAdopted(scope, source.id, 'completed'), /synthetic crash/);
        assert.deepEqual((await messages.getById(source.id)).queueCustody.handledByCatIds, []);
        const restartedMessages = new RedisMessageStore(redis);
        const restartedEvents = new RedisBallCustodyEventLog(redis);
        const receipt = new DispatchReceiptService({
          messageStore: restartedMessages,
          queue: new InvocationQueue(),
          coordinator: new QueuedMessageCustodyCoordinator({ messageStore: restartedMessages }),
          eventLog: restartedEvents,
        });
        await Promise.all([receipt.repairSource(source.id), receipt.repairSource(source.id)]);
        const recovered = await restartedMessages.getById(source.id);
        assert.equal(recovered.deliveryStatus, 'delivered');
        assert.deepEqual(recovered.queueCustody.handledByCatIds, ['codex-sol']);
        assert.equal(recovered.queueCustody.targetOutcomeByCatId['codex-sol'].evidenceRef.kind, 'dispatch_disposition');
        assert.equal(recovered.queueCustody.readEvidenceWitnesses?.length ?? 0, carrier === 'live' ? 1 : 0);
        assert.equal(await redis.ttl(`msg:${source.id}`), -1);
        assert.equal(
          (await restartedEvents.read('ball:thread:home')).filter(
            (event) => event.kind === 'ball.dispatch_dispositioned',
          ).length,
          1,
        );
      } finally {
        await unregister?.();
        await cleanupClientKeyspace(redis);
        await redis.quit();
      }
    },
  );
