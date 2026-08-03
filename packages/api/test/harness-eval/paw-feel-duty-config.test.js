import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import {
  PawFeelDutyConfigKey,
  PawFeelDutyConfigStoreError,
  RedisPawFeelDutyConfigStore,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/duty-config-store.js';
import {
  PawFeelDutyNoticeKey,
  RedisPawFeelDutyNoticeWatermarkStore,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/duty-notice.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const NOW = '2026-07-26T12:00:00.000Z';

describe('RedisPawFeelDutyConfigStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let watermarkStore;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F278 duty config');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisPawFeelDutyConfigStore(redis, () => NOW);
    watermarkStore = new RedisPawFeelDutyNoticeWatermarkStore(redis);
  });

  after(async () => {
    if (!redis || !connected) return;
    await redis.del(PawFeelDutyConfigKey, PawFeelDutyNoticeKey);
    await redis.quit();
  });

  beforeEach(async (context) => {
    if (!connected) return context.skip('Redis not connected');
    await redis.del(PawFeelDutyConfigKey, PawFeelDutyNoticeKey);
  });

  it('allows only a operator principal to make versioned duty assignments', async () => {
    await assert.rejects(
      store.update(
        { kind: 'cat', id: 'codex-sol' },
        { expectedVersion: 0, primaryCatId: 'codex-sol', backupCatId: 'opus' },
      ),
      (error) => error instanceof PawFeelDutyConfigStoreError && error.code === 'unauthorized',
    );

    const created = await store.update(
      { kind: 'cvo', id: 'you' },
      { expectedVersion: 0, primaryCatId: 'codex-sol', backupCatId: 'opus' },
    );
    assert.deepEqual(created, {
      systemThreadId: 'thread_eval_friction',
      primaryCatId: 'codex-sol',
      backupCatId: 'opus',
      version: 1,
      updatedAt: NOW,
      updatedBy: 'you',
    });
    assert.deepEqual(await store.read(), created);
    assert.equal(await redis.ttl(PawFeelDutyConfigKey), -1);

    await assert.rejects(
      store.update({ kind: 'cvo', id: 'you' }, { expectedVersion: 0, primaryCatId: 'fable-5', backupCatId: 'opus' }),
      (error) =>
        error instanceof PawFeelDutyConfigStoreError && error.code === 'version_conflict' && error.actualVersion === 1,
    );
  });

  it('rejects guessed or ambiguous duty and supports explicit operator reassignment', async () => {
    await assert.rejects(
      store.update({ kind: 'cvo', id: 'you' }, { expectedVersion: 0, primaryCatId: 'codex-sol' }),
      (error) => error instanceof PawFeelDutyConfigStoreError && error.code === 'invalid_config',
    );
    await assert.rejects(
      store.update(
        { kind: 'cvo', id: 'you' },
        { expectedVersion: 0, primaryCatId: 'codex-sol', backupCatId: 'codex-sol' },
      ),
      (error) => error instanceof PawFeelDutyConfigStoreError && error.code === 'invalid_config',
    );

    await store.update(
      { kind: 'cvo', id: 'you' },
      { expectedVersion: 0, primaryCatId: 'codex-sol', backupCatId: 'opus' },
    );
    const reassigned = await store.update(
      { kind: 'cvo', id: 'you' },
      { expectedVersion: 1, primaryCatId: 'fable-5', backupCatId: 'codex-sol' },
    );

    assert.equal(reassigned.version, 2);
    assert.equal(reassigned.primaryCatId, 'fable-5');
    assert.equal(reassigned.backupCatId, 'codex-sol');
    assert.equal(reassigned.systemThreadId, 'thread_eval_friction');
  });

  it('dedupes duty delivery and resumes invocation from its durable message receipt', async () => {
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW), { outcome: 'claimed' });
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW), { outcome: 'claimed_elsewhere' });

    await watermarkStore.markDelivered('watermark-1', 'message-1', NOW);
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW), {
      outcome: 'resume_invocation',
      messageId: 'message-1',
    });

    await watermarkStore.markComplete('watermark-1', NOW);
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW), { outcome: 'complete' });
    assert.deepEqual(await watermarkStore.claim('watermark-2', NOW), { outcome: 'claimed' });
    assert.equal(await redis.ttl(PawFeelDutyNoticeKey), -1);
  });
});
