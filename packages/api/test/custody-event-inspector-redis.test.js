/**
 * F167 PR-2 — the inspector over the REAL Redis event log and projection store.
 *
 * The in-memory test proves the shaping; this one proves the production read path: events appended through the
 * real ingest are read back through `RedisBallCustodyEventLog.read`, the projection comes from
 * `RedisBallCustodyProjectionStore.get`, and the anchor/window/whitelist hold on what Redis actually returned
 * (JSON round-trip included). Has Redis -> real; no isolated Redis -> skip.
 *
 * Isolation: unique keyPrefix, and every case uses its own thread and message ids, so there is no wildcard cleanup
 * to race with other Redis files (same approach as ball-custody-ingest-redis.test.js).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f167pr2-custody-inspector-test:';

describe('CustodyEventInspector (Redis read path)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let events;
  let BallCustodyIngest;
  let BallCustodyProjector;
  let CustodyEventInspector;
  let RedisBallCustodyEventLog;
  let RedisBallCustodyProjectionStore;
  let redis;
  let connected = false;
  let seq = 0;

  // sourceEventId is `task:<taskId>:done` and the seen-set is shared across cases, so task ids carry the thread too.
  const nextThread = () => `inspect-redis-${Date.now()}-${++seq}`;

  function stack() {
    const eventLog = new RedisBallCustodyEventLog(redis);
    const projectionStore = new RedisBallCustodyProjectionStore(redis);
    const ingest = new BallCustodyIngest(eventLog, new BallCustodyProjector(eventLog, projectionStore));
    const inspector = new CustodyEventInspector({
      ballCustodyEventLog: eventLog,
      ballCustodyProjectionStore: projectionStore,
    });
    return { eventLog, projectionStore, ingest, inspector };
  }

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'CustodyEventInspector');
    events = await import('../dist/domains/ball-custody/ball-custody-events.js');
    ({ BallCustodyIngest } = await import('../dist/domains/ball-custody/BallCustodyIngest.js'));
    ({ BallCustodyProjector } = await import('../dist/domains/ball-custody/BallCustodyProjector.js'));
    ({ CustodyEventInspector } = await import('../dist/domains/ball-custody/CustodyEventInspector.js'));
    ({ RedisBallCustodyEventLog } = await import('../dist/domains/ball-custody/BallCustodyEventLog.js'));
    ({ RedisBallCustodyProjectionStore } = await import('../dist/domains/ball-custody/BallCustodyProjectionStore.js'));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    connected = true;
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  it('895 / 971 shape: handoff, then the coordination terminal that wrote `completed`, read back from Redis', async () => {
    const threadId = nextThread();
    const messageId = `${threadId}/src`;
    const { ingest, inspector } = stack();
    await ingest.record(
      events.buildHandedEvent({ threadId, fromCatId: 'sonnet', toCatId: 'codex-astra', messageId, at: 1_000 }),
    );
    await ingest.record(
      events.buildDispatchDispositionEvent({
        threadId,
        catId: 'codex-astra',
        fromCatId: 'sonnet',
        invocationId: 'inv-1',
        sourceMessageId: messageId,
        disposition: 'completed',
        via: 'coordination_terminal',
        at: 2_000,
      }),
    );

    const result = await inspector.inspect({ threadId, sourceMessageId: messageId });

    assert.equal(result.status, 'ok');
    assert.equal(result.found, true);
    assert.equal(result.anchorSequence, 0);
    assert.deepEqual(
      result.events.map((event) => [event.sequence, event.kind, event.disposition, event.via]),
      [
        [0, 'ball.handed', undefined, undefined],
        [1, 'ball.dispatch_dispositioned', 'completed', 'coordination_terminal'],
      ],
    );
    assert.equal(result.truncated, false);
    assert.equal(result.projection.status, 'ok', 'the projection comes from the Redis store');
    assert.equal(result.projection.lastStateChangeAt, 2_000);
  });

  it('managed-hold wake: handoff, task.done at the thread subject, then the hold terminal, in stored order', async () => {
    const threadId = nextThread();
    const messageId = `${threadId}/wake`;
    const subjectKey = `ball:thread:${threadId}`;
    const { ingest, inspector } = stack();
    await ingest.record(events.buildHeldEvent({ threadId, catId: 'codex-sol', fireAt: 99_000, at: 1_000 }));
    await ingest.record(
      events.buildWakeConditionMetEvent({
        threadId,
        catId: 'codex-sol',
        taskId: `${threadId}/task-1`,
        command: 'pnpm test --secret-looking-flag',
        exitCode: 0,
        timedOut: false,
        durationMs: 5,
        at: 2_000,
      }),
    );
    await ingest.record(events.buildHandedEvent({ threadId, toCatId: 'codex-sol', messageId, at: 2_200 }));
    await ingest.record({ ...events.buildTaskDoneEvent({ taskId: `${threadId}/task-1`, at: 3_000 }), subjectKey });
    await ingest.record(
      events.buildHoldDispositionEvent({
        threadId,
        catId: 'codex-sol',
        invocationId: 'inv-9',
        sourceMessageId: messageId,
        taskId: `${threadId}/task-1`,
        disposition: 'handled',
        retired: true,
        retiredReason: 'subject_resolved',
        at: 4_000,
      }),
    );

    const result = await inspector.inspect({ threadId, sourceMessageId: messageId });

    assert.equal(result.status, 'ok');
    assert.equal(result.found, true);
    assert.deepEqual(
      result.events.map((event) => [event.sequence, event.kind]),
      [
        [2, 'ball.handed'],
        [3, 'task.done'],
        [4, 'ball.hold_dispositioned'],
      ],
      'from the handoff of the wake forward; the hold and the wake met are before the anchor',
    );
    assert.equal(result.events.at(-1).retiredReason, 'subject_resolved');
    assert.ok(
      !JSON.stringify(result).includes('secret-looking-flag'),
      'the wake command that Redis stored does not leave through the inspector',
    );
  });

  it('a message nothing references is found:false, and one with more events than the limit is truncated', async () => {
    const threadId = nextThread();
    const messageId = `${threadId}/src`;
    const { ingest, inspector } = stack();
    await ingest.record(
      events.buildHandedEvent({ threadId, fromCatId: 'sonnet', toCatId: 'codex-astra', messageId, at: 1_000 }),
    );
    for (let index = 0; index < 3; index += 1) {
      await ingest.record({
        ...events.buildTaskDoneEvent({ taskId: `${threadId}/task-${index}`, at: 2_000 + index }),
        subjectKey: `ball:thread:${threadId}`,
      });
    }

    const none = await inspector.inspect({ threadId, sourceMessageId: `${threadId}/never` });
    assert.equal(none.status, 'ok');
    assert.equal(none.found, false);
    assert.deepEqual(none.events, []);
    assert.equal(none.subjectEventCount, 4, 'the subject is not empty, so an empty list cannot read as "no ledger"');

    const cut = await inspector.inspect({ threadId, sourceMessageId: messageId, limit: 2 });
    assert.equal(cut.status, 'ok');
    assert.equal(cut.events.length, 2);
    assert.equal(cut.truncated, true);
  });

  it("another thread's ledger is never read: the same message id in a different thread is not found", async () => {
    const mine = nextThread();
    const theirs = nextThread();
    const messageId = `shared-message-${mine}`;
    const { ingest, inspector } = stack();
    await ingest.record(
      events.buildHandedEvent({ threadId: theirs, fromCatId: 'sonnet', toCatId: 'codex-astra', messageId, at: 1_000 }),
    );

    const result = await inspector.inspect({ threadId: mine, sourceMessageId: messageId });

    assert.equal(result.status, 'ok');
    assert.equal(result.found, false);
    assert.equal(result.subjectEventCount, 0);
    assert.equal(result.projection.status, 'not_found');
  });

  it('free text stored under the code keys does not come back from Redis either (review P1 on #5031)', async () => {
    const threadId = nextThread();
    const messageId = `${threadId}/src`;
    const sentinel = 'PRIVATE NOTE SENTINEL: arbitrary free text, not a custody code';
    const { eventLog, ingest, inspector } = stack();
    await ingest.record(
      events.buildHandedEvent({ threadId, fromCatId: 'sonnet', toCatId: 'codex-astra', messageId, at: 1_000 }),
    );
    const terminal = events.buildDispatchDispositionEvent({
      threadId,
      catId: 'codex-astra',
      fromCatId: 'sonnet',
      invocationId: 'inv-1',
      sourceMessageId: messageId,
      disposition: 'completed',
      via: 'direct',
      at: 2_000,
    });
    // An event as a stored or unknown writer could have left it: allowed keys, values that are not codes.
    await eventLog.append({
      ...terminal,
      payload: { ...terminal.payload, disposition: sentinel, via: sentinel, retiredReason: sentinel },
    });

    const result = await inspector.inspect({ threadId, sourceMessageId: messageId });

    assert.equal(result.status, 'ok');
    assert.equal(JSON.stringify(result).includes('SENTINEL'), false, JSON.stringify(result));
    assert.deepEqual(result.events[1].unrecognizedFields, ['disposition', 'retiredReason', 'via']);
    assert.equal(result.events[1].invocationId, 'inv-1', 'the identifiers beside them are untouched');
  });

  it('a Redis that cannot be read is unavailable, not an empty ledger', async () => {
    const threadId = nextThread();
    const { projectionStore } = stack();
    const inspector = new CustodyEventInspector({
      ballCustodyEventLog: {
        async read() {
          throw new Error('connection reset');
        },
      },
      ballCustodyProjectionStore: projectionStore,
    });

    const result = await inspector.inspect({ threadId, sourceMessageId: 'any' });

    assert.deepEqual(result, { status: 'unavailable', reason: 'event_log_read_failed' });
  });
});
