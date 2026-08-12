import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import {
  loadOrCreatePawFeelBundleSnapshotSigner,
  PawFeelBundleSnapshotSecretKey,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/bundle-snapshot.js';
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
const SNAPSHOT = {
  bundles: [{ bundleKey: 'bundle-1', members: [{ signalId: 'signal-1', expectedSequence: 1 }] }],
};

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
    await redis.del(PawFeelDutyConfigKey, PawFeelDutyNoticeKey, PawFeelBundleSnapshotSecretKey);
    await redis.quit();
  });

  beforeEach(async (context) => {
    if (!connected) return context.skip('Redis not connected');
    await redis.del(PawFeelDutyConfigKey, PawFeelDutyNoticeKey, PawFeelBundleSnapshotSecretKey);
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
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW, SNAPSHOT), { outcome: 'claimed' });
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW, SNAPSHOT), { outcome: 'claimed_elsewhere' });

    await watermarkStore.markDelivered('watermark-1', 'message-1', NOW);
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW, SNAPSHOT), {
      outcome: 'resume_invocation',
      watermark: 'watermark-1',
      messageId: 'message-1',
    });

    await watermarkStore.markAwaitingReceipt('watermark-1', NOW);
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW, SNAPSHOT), {
      outcome: 'resume_invocation',
      watermark: 'watermark-1',
      messageId: 'message-1',
    });
    assert.deepEqual(await watermarkStore.claim('watermark-2', NOW, SNAPSHOT), {
      outcome: 'resume_invocation',
      watermark: 'watermark-1',
      messageId: 'message-1',
    });
    await watermarkStore.markAwaitingReceipt('watermark-1', NOW);
    assert.deepEqual(await watermarkStore.readCurrent(), {
      watermark: 'watermark-1',
      status: 'awaiting_receipt',
      updatedAt: NOW,
      messageId: 'message-1',
      snapshot: SNAPSHOT,
    });

    await watermarkStore.markComplete('watermark-1', NOW);
    await watermarkStore.markComplete('watermark-1', NOW);
    assert.deepEqual(await watermarkStore.claim('watermark-1', NOW, SNAPSHOT), { outcome: 'complete' });
    assert.deepEqual(await watermarkStore.claim('watermark-2', NOW, SNAPSHOT), { outcome: 'claimed' });
    assert.equal(await redis.ttl(PawFeelDutyNoticeKey), -1);
  });

  it('reclaims pre-snapshot legacy records instead of wedging the scheduler', async () => {
    for (const status of ['claimed', 'delivered', 'awaiting_receipt']) {
      await redis.del(PawFeelDutyNoticeKey);
      await redis.hset(
        PawFeelDutyNoticeKey,
        'watermark',
        `legacy-${status}`,
        'status',
        status,
        'updatedAt',
        NOW,
        'messageId',
        'legacy-message',
      );

      assert.deepEqual(await watermarkStore.claim(`fresh-${status}`, NOW, SNAPSHOT), { outcome: 'claimed' });
      assert.deepEqual(await watermarkStore.readCurrent(), {
        watermark: `fresh-${status}`,
        status: 'claimed',
        updatedAt: NOW,
        snapshot: SNAPSHOT,
      });
    }
  });

  it('keeps bundle snapshot tokens valid across signer reconstruction without expiring the secret', async () => {
    const members = [{ signalId: 'signal-1', expectedSequence: 1 }];
    const first = await loadOrCreatePawFeelBundleSnapshotSigner(redis);
    const token = first.sign('bundle-1', members);

    const reconstructed = await loadOrCreatePawFeelBundleSnapshotSigner(redis);
    reconstructed.assert('bundle-1', members, token);
    assert.equal(await redis.ttl(PawFeelBundleSnapshotSecretKey), -1);

    await redis.set(PawFeelBundleSnapshotSecretKey, 'corrupt');
    await assert.rejects(loadOrCreatePawFeelBundleSnapshotSigner(redis), /invalid.*snapshot secret/i);
  });

  it('fails closed when durable duty recovery state is malformed', async () => {
    await watermarkStore.claim('watermark-1', NOW, SNAPSHOT);
    await assert.rejects(
      watermarkStore.markComplete('watermark-1', NOW),
      /watermark or state changed before completion/,
    );
    await redis.hset(PawFeelDutyNoticeKey, 'status', 'corrupted');
    await assert.rejects(watermarkStore.readCurrent(), /invalid paw-feel duty batch status/);

    await redis.hset(PawFeelDutyNoticeKey, 'status', 'awaiting_receipt', 'snapshot', JSON.stringify({ bundles: [] }));
    await assert.rejects(watermarkStore.readCurrent(), /invalid paw-feel duty batch snapshot/);
  });
});
