/**
 * F167 / #5049 review (codex61-sol): the event-wait completion terminal against production-shaped inputs.
 *
 * The five cases below are Sol's reproductions, adapted: each failed on real Redis and in memory, and each is a way
 * the terminal's identity or replay semantics disagreed with what production actually produces:
 *  1. wakes come from the REAL deployment lifecycle (two Tasks waiting on the same deployment share an outcomeId and
 *     differ only in waitId, which is the Task id);
 *  2. an old wake must not end the ball that a LATER accepted hold by the same cat now carries;
 *  3. a successor invocation must see the exact terminal that already exists (durable per-wake truth);
 *  4. a replay must converge the projection from the durable log, not trust a success receipt;
 *  5. two concurrent calls with conflicting values inside one invocation cannot both report `applied`.
 *
 * Both backends run: memory (whose fenced append now matches the production Lua: duplicate BEFORE the sequence fence)
 * and real isolated Redis.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { RedisBallCustodyEventLog } from '../dist/domains/ball-custody/BallCustodyEventLog.js';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { RedisBallCustodyProjectionStore } from '../dist/domains/ball-custody/BallCustodyProjectionStore.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHandedEvent, buildHeldEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { EventWaitDispositionService } from '../dist/domains/ball-custody/EventWaitDispositionService.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { PersistedQueueDelivery } from '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { DeploymentWaitLifecycleService } from '../dist/domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { matchedOutcomeId } from '../dist/domains/runtime-deployment/DeploymentWaitOutcome.js';
import { realWaitWake } from './helpers/event-wait-terminal-fixture.js';
import { MemoryEventLog, MemoryProjectionStore } from './helpers/memory-ball-custody.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

/** Two independent Task waits on the SAME deployment, each woken through the real lifecycle service. */
async function realDeploymentWakes(threadId, catId) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const subjectRef = `deployment:${randomUUID()}:runtime`;
  const observation = {
    subjectRef,
    bootId: 'boot-new',
    bootSequence: 2,
    runningRevision: '2'.repeat(40),
    readyServices: ['api'],
    observedAt: 500,
    inclusionProof: {
      kind: 'git_ancestry',
      targetRevision: '1'.repeat(40),
      runningRevision: '2'.repeat(40),
      included: true,
    },
  };
  const lifecycle = new DeploymentWaitLifecycleService({
    taskStore,
    deliveryDeps: {
      delivery: new PersistedQueueDelivery({
        messages: messageStore,
        queue: new InvocationQueue(),
        progress: async () => ({ kind: 'queued' }),
      }),
    },
    now: () => 500,
    log: { info() {}, warn() {}, error() {} },
    currentObservation: async () => observation,
  });
  const results = [];
  for (const title of ['first wait', 'second wait']) {
    const task = await taskStore.create({
      kind: 'work',
      threadId,
      title,
      ownerCatId: catId,
      createdBy: catId,
      userId: 'user-1',
      why: 'review witness',
    });
    const active = {
      v: 1,
      generation: 1,
      subjectRef,
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: { bootSequence: 1, bootId: 'boot-old', capturedAt: 100 },
      continuation: {
        when: [{ kind: 'revision_included', revision: '1'.repeat(40), services: ['api'] }],
        // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract names this continuation field `then`.
        then: 'Verify.',
      },
      autoRenew: false,
      createdAt: 100,
    };
    const receipt = createTypedWaitRegistration({
      task,
      active,
      invocationId: 'registration',
      source: { kind: 'primary', sourceMessageId: 'registration-source' },
    });
    assert.ok(receipt);
    assert.ok(
      await taskStore.replaceDeploymentWaitIfGeneration(task.id, {
        expectedGeneration: null,
        expectedDeploymentWait: task.deploymentWait,
        expectedUpdatedAt: task.updatedAt,
        deploymentWait: { await: active },
        waitRegistration: receipt,
      }),
    );
    const delivered = await lifecycle.observe({ taskId: task.id, observation });
    assert.equal(delivered.kind, 'notified');
    const message = await messageStore.getById(delivered.messageId);
    results.push({ message, carrier: message.source.meta.waitContinuationCarrier });
  }
  assert.equal(results[0].carrier.outcomeId, matchedOutcomeId(subjectRef, 1));
  return results;
}

for (const backend of ['memory', 'redis']) {
  describe(
    `event-wait completion, production shapes (${backend})`,
    {
      skip: backend === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false,
    },
    () => {
      let redis;
      before(async () => {
        if (backend !== 'redis') return;
        assertRedisIsolationOrThrow(process.env.REDIS_URL, 'event-wait-production-shapes');
        const { createRedisClient } = await import('@cat-cafe/shared/utils');
        redis = createRedisClient({
          url: process.env.REDIS_URL,
          keyPrefix: `f167-event-wait-production-shapes:${randomUUID()}:`,
        });
        await redis.ping();
      });
      after(async () => {
        if (redis) await redis.quit();
      });

      async function world() {
        const threadId = `thread-${randomUUID()}`;
        const subjectKey = `ball:thread:${threadId}`;
        const catId = 'codex-astra';
        const eventLog = redis ? new RedisBallCustodyEventLog(redis) : new MemoryEventLog();
        const projectionStore = redis ? new RedisBallCustodyProjectionStore(redis) : new MemoryProjectionStore();
        const ingest = new BallCustodyIngest(eventLog, new BallCustodyProjector(eventLog, projectionStore));
        const registry = new InvocationRegistry();
        const messages = new Map();
        let repairCalls = 0;
        let failRepair = false;
        const service = new EventWaitDispositionService({
          registry,
          messageStore: { getById: async (id) => messages.get(id) ?? null },
          ballCustodyEventLog: eventLog,
          ballCustodyProjectionStore: projectionStore,
          ballCustody: ingest,
          repairProjection: async (key) => {
            repairCalls += 1;
            if (failRepair) throw new Error('transient repair unavailable');
            await ingest.rebuild(key);
          },
        });
        const gate = new TurnCustodyProjectionService({
          ballCustodyEventLog: eventLog,
          ballCustodyProjectionStore: projectionStore,
        });
        async function caller(messageId) {
          const { invocationId } = await registry.create(
            'user-1',
            catId,
            threadId,
            undefined,
            undefined,
            undefined,
            messageId,
          );
          return registry.peekRecord(invocationId);
        }
        async function expose(carrier, message) {
          const messageId = message?.id ?? `wake-${randomUUID()}`;
          messages.set(
            messageId,
            message ?? {
              id: messageId,
              threadId,
              source: { connector: 'deployment-wait', meta: { waitContinuationCarrier: carrier } },
            },
          );
          await ingest.record(buildHandedEvent({ threadId, toCatId: catId, messageId, at: Date.now() }));
          const wake = {
            kind: 'structured',
            protocol: 'event_wait',
            subjectKey,
            holderCatId: catId,
            waitContinuationCarrier: carrier,
          };
          return { auth: await caller(messageId), wake, messageId };
        }
        const carrier = realWaitWake('matched', {
          holderCatId: catId,
          subjectKey,
          subjectRef: `pr:repo#${randomUUID()}`,
        }).waitContinuationCarrier;
        return {
          threadId,
          subjectKey,
          catId,
          carrier,
          eventLog,
          projectionStore,
          ingest,
          service,
          gate,
          expose,
          caller,
          repairCount: () => repairCalls,
          failRepair: (value) => {
            failRepair = value;
          },
        };
      }
      const terminalsOf = async (w) =>
        (await w.eventLog.read(w.subjectKey)).filter((e) => e.kind === 'ball.wait_dispositioned');

      test('control: lifecycle completion resolves the wait without a separate Stop gate', async () => {
        const w = await world();
        const s = await w.expose(w.carrier);
        const opened = await w.gate.open(s.wake);
        assert.equal((await w.gate.close(opened)).shouldBlock, false);

        await w.service.complete(s.auth, 'completed');

        assert.equal((await w.gate.close(opened)).shouldBlock, false);
        assert.equal((await w.projectionStore.get(w.subjectKey)).state, 'resolved');
      });

      test('1. two Task waits on the same deployment have separate completion identities', async () => {
        const w = await world();
        const [firstWake, secondWake] = await realDeploymentWakes(w.threadId, w.catId);
        const first = firstWake.carrier;
        const second = secondWake.carrier;
        assert.equal(first.outcomeId, second.outcomeId, 'the production outcomeId is shared');
        assert.notEqual(first.waitId, second.waitId);
        assert.notEqual(firstWake.message.id, secondWake.message.id);

        const a = await w.expose(first, firstWake.message);
        await w.service.complete(a.auth, 'completed');
        const b = await w.expose(second, secondWake.message);
        await w.service.complete(b.auth, 'completed');

        assert.equal((await terminalsOf(w)).length, 2, 'both independent wait registrations can settle');
      });

      test('2. completing an old wake preserves a later accepted hold by the same cat', async () => {
        const w = await world();
        const s = await w.expose(w.carrier);
        const opened = await w.gate.open(s.wake);
        const fireAt = Date.now() + 60_000;
        await w.ingest.record(buildHeldEvent({ threadId: w.threadId, catId: w.catId, at: Date.now() + 1, fireAt }));
        assert.equal((await w.gate.close(opened)).shouldBlock, false, 'the re-hold already continued this wake');
        const before = await w.projectionStore.get(w.subjectKey);
        assert.equal(before.state, 'active');
        assert.equal(before.heldUntil, fireAt);

        const completion = await w.service.complete(s.auth, 'completed');

        const after = await w.projectionStore.get(w.subjectKey);
        assert.equal(after.state, 'active', 'settling the old wake must not resolve its replacement hold');
        assert.equal(after.heldUntil, before.heldUntil);
        assert.equal(completion.retired, true);
        assert.equal(completion.retiredReason, 'superseded');
      });

      test('3. a successor stop check recognizes the exact already committed wake terminal', async () => {
        const w = await world();
        const s = await w.expose(w.carrier);
        await w.service.complete(s.auth, 'completed');
        const successor = await w.caller(s.messageId);

        const opened = await w.gate.open(s.wake);
        const replay = await w.service.complete(successor, 'handled');

        assert.equal(replay.outcome, 'replayed');
        assert.equal(replay.disposition, 'completed');
        assert.equal(
          (await w.gate.close(opened)).shouldBlock,
          false,
          'durable per-wake truth survives a successor invocation',
        );
      });

      test('4. a replay repairs a durable append whose projection and first repair failed', async () => {
        const w = await world();
        const s = await w.expose(w.carrier);
        const save = w.projectionStore.save.bind(w.projectionStore);
        let failSave = true;
        w.projectionStore.save = async (p) => {
          if (failSave && p.state === 'resolved') throw new Error('transient save failure');
          return save(p);
        };
        w.failRepair(true);
        await assert.rejects(w.service.complete(s.auth, 'completed'));
        assert.equal((await terminalsOf(w)).length, 1);
        assert.equal((await w.projectionStore.get(w.subjectKey)).state, 'active');

        failSave = false;
        w.failRepair(false);
        const successor = await w.caller(s.messageId);
        const result = await w.service.complete(successor, 'completed');

        assert.equal(result.outcome, 'replayed');
        assert.equal(
          (await w.projectionStore.get(w.subjectKey)).state,
          'resolved',
          'a successful retry converges from the durable log',
        );
        assert.equal(w.repairCount(), 2);
      });

      /** Hold the first two pre-append reads until both calls have their snapshot, so both reach the append. */
      function holdFirstTwoReads(w) {
        const read = w.eventLog.read.bind(w.eventLog);
        let initialReads = 0;
        let release;
        const ready = new Promise((resolve) => {
          release = resolve;
        });
        w.eventLog.read = async (...args) => {
          const captured = await read(...args);
          if (initialReads < 2 && !captured.some((e) => e.kind === 'ball.wait_dispositioned')) {
            initialReads += 1;
            if (initialReads === 2) release();
            await ready;
          }
          return captured;
        };
      }

      test('6. concurrent calls that agree: exactly one is the recorded write, the other replays it', async () => {
        const w = await world();
        const s = await w.expose(w.carrier);
        holdFirstTwoReads(w);

        const results = await Promise.all([
          w.service.complete(s.auth, 'completed'),
          w.service.complete(s.auth, 'completed'),
        ]);

        assert.equal((await terminalsOf(w)).length, 1);
        assert.deepEqual(results.map((r) => r.outcome).sort(), ['applied', 'replayed']);
        assert.ok(results.every((r) => r.disposition === 'completed'));
        assert.equal((await w.projectionStore.get(w.subjectKey)).state, 'resolved');
      });

      // #5049 round 2: the wake enters the turn when it is not provably live, so open has no baseline.
      for (const [label, replace] of [
        [
          'the subject resolved after the wake was delivered',
          (w) =>
            w.ingest.record({
              kind: 'task.done',
              sourceEventId: `task:${randomUUID()}:done`,
              subjectKey: w.subjectKey,
              classification: 'state-changing',
              payload: { taskId: 't1' },
              at: Date.now() + 1,
            }),
        ],
        [
          'the ball was handed to another cat after the wake',
          (w) =>
            w.ingest.record(
              buildHandedEvent({
                threadId: w.threadId,
                toCatId: 'opus55',
                messageId: `later-${randomUUID()}`,
                at: Date.now() + 1,
              }),
            ),
        ],
      ]) {
        test(`8. ${label}: the retired terminal written in THIS turn settles the stop check`, async () => {
          const w = await world();
          const s = await w.expose(w.carrier);
          await replace(w);
          const opened = await w.gate.open(s.wake);
          assert.equal(opened.state, 'covered_empty', 'typed waits are owned by their lifecycle');
          assert.equal((await w.gate.close(opened)).shouldBlock, false, 'Stop does not duplicate wait ownership');

          const completion = await w.service.complete(s.auth, 'completed');

          assert.equal(completion.retired, true);
          const settled = await w.gate.close(opened);
          assert.equal(settled.shouldBlock, false, 'the current turn must see the terminal it just wrote');
          assert.equal(settled.structuredTransitionKind, undefined);
          assert.equal((await terminalsOf(w)).length, 1);
        });
      }

      test('5. concurrent conflicting calls within one invocation: the non-recorded request cannot report applied', async () => {
        const w = await world();
        const s = await w.expose(w.carrier);
        holdFirstTwoReads(w);

        const results = await Promise.allSettled([
          w.service.complete(s.auth, 'completed'),
          w.service.complete(s.auth, 'handled'),
        ]);

        assert.equal((await terminalsOf(w)).length, 1, 'one terminal on the log');
        const applied = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'applied');
        const refused = results.filter(
          (r) => r.status === 'rejected' && r.reason.code === 'event_wait_disposition_replay_mismatch',
        );
        assert.equal(applied.length, 1, 'exactly one request is the one that was recorded');
        assert.equal(refused.length, 1, 'the other, conflicting request fails closed');
        assert.equal(
          applied[0].value.disposition,
          (await terminalsOf(w))[0].payload.disposition,
          'applied == what the log holds',
        );
      });
    },
  );
}
