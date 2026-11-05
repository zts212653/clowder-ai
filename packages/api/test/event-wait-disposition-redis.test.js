/**
 * F167 — the event-wait completion terminal over the REAL Redis event log, projection store and fenced append.
 *
 * The in-memory tests prove the decisions; this one proves the production path: the fenced append (CAS on the
 * subject's sequence), the read-back by sourceEventId, and the stop gate reading the terminal out of Redis. Has
 * Redis -> real; no isolated Redis -> skip. Unique keyPrefix, and every case has its own thread, message and
 * wait subject, so there is no wildcard cleanup to race with other Redis files.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { realWaitWake } from './helpers/event-wait-terminal-fixture.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f167-event-wait-disposition-test:';
const HOLDER = 'codex-astra';

describe('EventWaitDispositionService (Redis path)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let events;
  let BallCustodyIngest;
  let BallCustodyProjector;
  let EventWaitDispositionService;
  let TurnCustodyProjectionService;
  let RedisBallCustodyEventLog;
  let RedisBallCustodyProjectionStore;
  let redis;
  let connected = false;
  let seq = 0;

  function stack(threadId, wake) {
    const eventLog = new RedisBallCustodyEventLog(redis);
    const projectionStore = new RedisBallCustodyProjectionStore(redis);
    const ingest = new BallCustodyIngest(eventLog, new BallCustodyProjector(eventLog, projectionStore));
    const carrier = wake.waitContinuationCarrier;
    const service = new EventWaitDispositionService({
      registry: { isLatest: async () => true },
      messageStore: {
        getById: async (id) =>
          id === `${threadId}/wake`
            ? { id, threadId, source: { connector: 'deployment-wait', meta: { waitContinuationCarrier: carrier } } }
            : null,
      },
      ballCustodyEventLog: eventLog,
      ballCustodyProjectionStore: projectionStore,
      ballCustody: ingest,
      repairProjection: (subjectKey) => ingest.rebuild(subjectKey),
    });
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: projectionStore,
      ballCustodyEventLog: eventLog,
    });
    return { eventLog, projectionStore, ingest, service, gate };
  }

  /** A thread, its wake (a REAL matched outcome with a subject unique to this case) and the stack over Redis. */
  async function scenario() {
    const threadId = `event-wait-redis-${Date.now()}-${++seq}`;
    const subjectKey = `ball:thread:${threadId}`;
    const wake = realWaitWake('matched', {
      holderCatId: HOLDER,
      subjectKey,
      subjectRef: `pr:zts212653/clowder-ai#${threadId}`,
    });
    const s = stack(threadId, wake);
    await s.ingest.record(
      events.buildHandedEvent({ threadId, toCatId: HOLDER, messageId: `${threadId}/wake`, at: 1_000 }),
    );
    const auth = (overrides = {}) => ({
      invocationId: 'inv-1',
      userId: 'user-1',
      catId: HOLDER,
      threadId,
      originTriggerMessageId: `${threadId}/wake`,
      ...overrides,
    });
    return { ...s, threadId, subjectKey, wake, auth };
  }

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'EventWaitDispositionService');
    events = await import('../dist/domains/ball-custody/ball-custody-events.js');
    ({ BallCustodyIngest } = await import('../dist/domains/ball-custody/BallCustodyIngest.js'));
    ({ BallCustodyProjector } = await import('../dist/domains/ball-custody/BallCustodyProjector.js'));
    ({ EventWaitDispositionService } = await import('../dist/domains/ball-custody/EventWaitDispositionService.js'));
    ({ TurnCustodyProjectionService } = await import('../dist/domains/ball-custody/TurnCustodyProjectionService.js'));
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

  it('completes through the fenced append: one terminal in Redis, the ball resolves, the stop gate reads it', async () => {
    const s = await scenario();
    const opened = await s.gate.open(s.wake);
    assert.equal(opened.state, 'covered_empty', 'main treats event-wait continuation as a structured lifecycle wake');
    assert.equal((await s.gate.close(opened)).shouldBlock, false);

    const result = await s.service.complete(s.auth(), 'completed');

    assert.equal(result.outcome, 'applied');
    assert.equal(result.retired, false);
    const stored = (await s.eventLog.read(s.subjectKey)).filter((event) => event.kind === 'ball.wait_dispositioned');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].payload.outcomeId, s.wake.waitContinuationCarrier.outcomeId);
    assert.equal((await s.projectionStore.get(s.subjectKey)).state, 'resolved');
    const decision = await s.gate.close(opened);
    assert.equal(decision.shouldBlock, false);
    assert.equal(
      decision.state,
      'covered_empty',
      'the retained terminal does not create an action-successor obligation',
    );
  });

  it('a replay and a successor invocation see the recorded terminal; no second one is written', async () => {
    const s = await scenario();
    await s.service.complete(s.auth(), 'completed');

    const again = await s.service.complete(s.auth(), 'completed');
    const successor = await s.service.complete(s.auth({ invocationId: 'inv-2' }), 'handled');

    assert.equal(again.outcome, 'replayed');
    assert.equal(successor.outcome, 'replayed');
    assert.equal(successor.disposition, 'completed', 'the recorded terminal stays authoritative');
    const stored = (await s.eventLog.read(s.subjectKey)).filter((event) => event.kind === 'ball.wait_dispositioned');
    assert.equal(stored.length, 1);
  });

  it('when the ball moved on the terminal is retired and the other holder keeps it', async () => {
    const s = await scenario();
    await s.ingest.record(
      events.buildHandedEvent({ threadId: s.threadId, toCatId: 'opus55', messageId: `${s.threadId}/later`, at: 2_000 }),
    );

    const result = await s.service.complete(s.auth(), 'completed');

    assert.equal(result.retired, true);
    assert.equal(result.retiredReason, 'ball_not_held');
    const projection = await s.projectionStore.get(s.subjectKey);
    assert.equal(projection.holder, 'opus55');
    assert.equal(projection.state, 'active');
  });
});
