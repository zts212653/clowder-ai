/**
 * Guards the keyspace isolation that the two auth-invocation suites depend on.
 *
 * Why this file exists rather than a concurrency stress run: the hazard is a
 * scheduling window, and a window is not a reliable witness. Running both
 * suites twelve times at `--test-concurrency=4` on the pre-fix code produced
 * twelve green runs — the race is real by construction but did not surface
 * under that scheduler. So the hazard is demonstrated directly instead: one
 * client performing the old shared-prefix wipe, against a record another client
 * has written and not yet read.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';

const REDIS_URL = process.env.REDIS_URL;
const HAS_REDIS = REDIS_URL?.includes(':6398') === true;

describe('auth-invocation test keyspace isolation', () => {
  test('namespaces are unique per call, so two suites cannot share one prefix', () => {
    const a = createAuthTestNamespace('auth-restart');
    const b = createAuthTestNamespace('auth-contract');
    const c = createAuthTestNamespace('auth-restart');

    assert.notEqual(a, b, 'different suites must not collide');
    assert.notEqual(a, c, 'repeat runs of one suite must not collide either');
    assert.match(a, /^cat-cafe-test:auth-restart-\d+-[0-9a-f]{8}:$/);
    assert.throws(() => createAuthTestNamespace(''), TypeError);
  });

  test('the old shared prefix let one suite delete another suite record', async (t) => {
    if (!HAS_REDIS) {
      t.skip('requires the isolated development Redis');
      return;
    }
    const { createRedisClient } = await import('@cat-cafe/shared/utils');

    // Reproduces the pre-fix arrangement: both clients on `cat-cafe-test:`,
    // one of them wiping `cat-cafe-test:auth:*` as its fixture setup.
    const shared = 'cat-cafe-test:';
    const writer = createRedisClient({ url: REDIS_URL, keyPrefix: shared });
    const wiper = createRedisClient({ url: REDIS_URL, keyPrefix: shared });
    try {
      await writer.set('auth:shared-prefix-witness', 'written-not-yet-read', 'EX', 60);

      const victims = await wiper.keys('cat-cafe-test:auth:*');
      if (victims.length > 0) {
        await wiper.del(...victims.map((key) => key.replace(shared, '')));
      }

      assert.equal(
        await writer.get('auth:shared-prefix-witness'),
        null,
        'the shared-prefix wipe must be shown to destroy the other suite record',
      );
    } finally {
      await writer.del('auth:shared-prefix-witness');
      await writer.quit();
      await wiper.quit();
    }
  });

  test('a per-suite namespace survives the other suite cleanup', async (t) => {
    if (!HAS_REDIS) {
      t.skip('requires the isolated development Redis');
      return;
    }
    const { createRedisClient } = await import('@cat-cafe/shared/utils');

    const restartNs = createAuthTestNamespace('auth-restart');
    const contractNs = createAuthTestNamespace('auth-contract');
    const restart = createRedisClient({ url: REDIS_URL, keyPrefix: restartNs });
    const contract = createRedisClient({ url: REDIS_URL, keyPrefix: contractNs });
    try {
      await restart.set('auth:survive-restart-1', 'tok-survive', 'EX', 60);
      await contract.set('auth:inv-1', 'tok-1', 'EX', 60);
      await contract.set('auth:inv-2', 'tok-2', 'EX', 60);

      const removed = await clearAuthTestNamespace(contract, contractNs);
      assert.equal(removed, 2, 'cleanup must report both of its own keys');

      // `removed` is derived from keys(), so it stays 2 even if del() silently
      // deletes nothing — which is exactly what a broken prefix strip does,
      // since keys() returns fully-prefixed keys and del() re-applies the
      // client keyPrefix. Read the keys back to assert the deletion happened.
      assert.equal(await contract.get('auth:inv-1'), null, 'cleanup must actually delete its own keys');
      assert.equal(await contract.get('auth:inv-2'), null, 'cleanup must delete every key it reported');

      assert.equal(
        await restart.get('auth:survive-restart-1'),
        'tok-survive',
        'the restart record must outlive an unrelated suite cleanup',
      );
    } finally {
      await clearAuthTestNamespace(restart, restartNs);
      await restart.quit();
      await contract.quit();
    }
  });
});
