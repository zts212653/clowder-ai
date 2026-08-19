import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import {
  PawFeelDispositionKeys,
  RedisPawFeelDispositionEventLog,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/event-log.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const DIGEST = 'a'.repeat(64);
const SIGNAL_ID = `message-1:${DIGEST}:0`;
const TEST_KEYS = [
  PawFeelDispositionKeys.eventLog(SIGNAL_ID),
  PawFeelDispositionKeys.eventsSeen,
  PawFeelDispositionKeys.signals,
];

function discovered(overrides = {}) {
  return {
    eventId: 'event-discovered',
    signalId: SIGNAL_ID,
    type: 'discovered',
    actor: { kind: 'automation', id: 'reconciler' },
    occurredAt: '2026-07-26T00:00:00.000Z',
    source: {
      sourceMessageId: 'message-1',
      sourceThreadId: 'thread-1',
      sourceCatId: 'codex-sol',
      markerDigest: DIGEST,
      sameDigestOrdinal: 0,
      markerIndex: 0,
    },
    backfilled: false,
    captureMethod: 'legacy_parser',
    captureAssessment: 'ambiguous',
    ...overrides,
  };
}

function seen(eventId, actorId = 'opus') {
  return {
    eventId,
    signalId: SIGNAL_ID,
    type: 'seen',
    actor: { kind: 'cat', id: actorId },
    occurredAt: '2026-07-26T01:00:00.000Z',
  };
}

describe('RedisPawFeelDispositionEventLog', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let log;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F278 disposition event log');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    log = new RedisPawFeelDispositionEventLog(redis);
  });

  after(async () => {
    if (!redis || !connected) return;
    await redis.del(...TEST_KEYS);
    await redis.quit();
  });

  beforeEach(async (context) => {
    if (!connected) return context.skip('Redis not connected');
    await redis.del(...TEST_KEYS);
  });

  it('round-trips append-only events, indexes signal ids and never applies TTL', async () => {
    assert.deepEqual(await log.append(discovered(), 0), { outcome: 'appended', sequence: 0 });
    assert.deepEqual(await log.append(seen('event-seen'), 1), { outcome: 'appended', sequence: 1 });
    assert.deepEqual(await log.read(SIGNAL_ID), [discovered(), seen('event-seen')]);
    assert.deepEqual(await log.listSignalIds(), [SIGNAL_ID]);
    assert.equal(await redis.ttl(PawFeelDispositionKeys.eventLog(SIGNAL_ID)), -1);
    assert.equal(await redis.ttl(PawFeelDispositionKeys.signals), -1);
  });

  it('checks duplicate ids before sequence conflicts for retry idempotency', async () => {
    await log.append(discovered(), 0);
    await log.append(seen('event-seen'), 1);
    assert.deepEqual(await log.append(discovered(), 0), { outcome: 'duplicate' });
    assert.deepEqual(await log.append(seen('other-event'), 0), { outcome: 'conflict', actualSequence: 2 });
  });

  it('linearizes concurrent writers at one expected sequence', async () => {
    await log.append(discovered(), 0);
    const results = await Promise.all([log.append(seen('event-a'), 1), log.append(seen('event-b', 'fable-5'), 1)]);
    assert.equal(results.filter((result) => result.outcome === 'appended').length, 1);
    assert.equal(results.filter((result) => result.outcome === 'conflict').length, 1);
    assert.equal((await log.read(SIGNAL_ID)).length, 2);
  });

  it('reads many signal logs through one pipeline without changing event order', async () => {
    await log.append(discovered(), 0);
    await log.append(seen('event-seen'), 1);

    const result = await log.readMany([SIGNAL_ID]);

    assert.deepEqual(result.get(SIGNAL_ID), [discovered(), seen('event-seen')]);
  });
});
