import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  MemoryConciergeConfigStore,
  RedisConciergeConfigStore,
} from '../dist/domains/concierge/ConciergeConfigStore.js';
import { ConciergeKeys } from '../dist/domains/concierge/concierge-keys.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const fixture = ownedRedisFixture('f317-app-assist');
const key = (n) => createHash('sha256').update(`fixture-${n}`).digest('hex');
for (const adapter of ['memory', 'redis']) {
  test(`${adapter}: consent and daily claim are atomic, bounded and durable without application content`, async () => {
    const client = adapter === 'redis' ? fixture.client('day:') : null;
    const store = client ? new RedisConciergeConfigStore(client) : new MemoryConciergeConfigStore();
    assert.equal(await store.claimAppAssistDay('owner', key(1), '2030-01-02'), 'disabled');
    await store.patch('owner', { appAssistEnabled: true });
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => store.claimAppAssistDay('owner', key(1), '2030-01-02')),
    );
    assert.equal(claims.filter((v) => v === 'claimed').length, 1);
    assert.equal(claims.filter((v) => v === 'already_claimed').length, 11);
    await Promise.all([
      store.patch('owner', { appAssistEnabled: false }),
      store.patch('owner', { personaTone: 'Fixture' }),
    ]);
    assert.equal((await store.getSaved('owner')).appAssistEnabled, false);
    assert.equal(await store.claimAppAssistDay('owner', key(2), '2030-01-02'), 'disabled');
    await store.patch('owner', { appAssistEnabled: true });
    assert.equal(await store.claimAppAssistDay('owner', key(1), '2030-01-02'), 'already_claimed');
    for (let n = 2; n <= 256; n++)
      assert.equal(await store.claimAppAssistDay('owner', key(n), '2030-01-02'), 'claimed');
    assert.equal(await store.claimAppAssistDay('owner', key(257), '2030-01-02'), 'capacity');
    assert.equal(await store.claimAppAssistDay('owner', key(1), '2030-01-01'), 'clock_rollback');
    assert.equal(await store.claimAppAssistDay('owner', key(1), '2030-01-03'), 'claimed');
    assert.equal(await store.claimAppAssistDay('other', key(1), '2030-01-03'), 'disabled');
    await store.patch('owner', { muted: true });
    assert.equal(await store.claimAppAssistDay('owner', key(2), '2030-01-03'), 'disabled');
    await assert.rejects(store.claimAppAssistDay('owner', 'org.fixture.raw', '2030-01-03'));
    if (client) {
      const saved = JSON.parse(await client.get(ConciergeKeys.appAssistDay('owner')));
      assert.deepEqual(saved, { day: '2030-01-03', keys: [key(1)] });
      assert.equal(await client.ttl(ConciergeKeys.config('owner')), -1);
      assert.equal(await client.ttl(ConciergeKeys.appAssistDay('owner')), -1);
      const restarted = new RedisConciergeConfigStore(fixture.client('day:'));
      await restarted.patch('owner', { muted: false });
      assert.equal(await restarted.claimAppAssistDay('owner', key(1), '2030-01-03'), 'already_claimed');
      assert.deepEqual((await client.keys('day:*')).sort(), [
        'day:concierge:app-assist-day:owner',
        'day:concierge:config:owner',
      ]);
    }
  });
}

test('two real Redis adapters propagate opt-out and subscription loss without waiting for application activation', async (t) => {
  const first = fixture.client('watch:');
  const second = fixture.client('watch:');
  const storeA = new RedisConciergeConfigStore(first);
  const storeB = new RedisConciergeConfigStore(second);
  const changes = [];
  let changed;
  const next = () =>
    new Promise((resolve) => {
      changed = resolve;
    });
  const dispose = await storeA.watchAppAssistPolicy('owner', (value) => {
    changes.push(value);
    changed?.();
  });
  t.after(dispose);
  let update = next();
  await storeB.patch('owner', { appAssistEnabled: true });
  await update;
  assert.equal(changes.at(-1), true);
  update = next();
  await storeB.patch('owner', { appAssistEnabled: false });
  await update;
  assert.equal(changes.at(-1), false);
  assert.equal(await storeA.claimAppAssistDay('owner', key(1), '2030-01-02'), 'disabled');
  update = next();
  // Only the subscription on this portless fixture server is disconnected.
  await second.client('KILL', 'TYPE', 'pubsub');
  await update;
  assert.equal(changes.at(-1), null);
});
