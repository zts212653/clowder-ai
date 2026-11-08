import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { recoveryRedis } from '../dist/infrastructure/recovery/recovery-redis.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('1843-recovery-client-identity');
const coverage = { threadId: 'home', entries: [], responseMessageId: 'absent-response' };
const append = {
  threadId: 'home',
  sourceMessageId: 'absent-source',
  failure: { responseMessageId: 'absent-response' },
};

test('both real lifecycle helpers accept only their matching underlying Redis transport through recovery wrappers', async () => {
  const raw = owned.client('same:'),
    store = new RedisMessageStore(raw),
    ledger = new RedisQueueLedgerStore(raw);
  assert.equal((await store.commitLifecycleWakeCoverage(coverage, ledger)).kind, 'not_found');
  assert.equal((await store.commitLifecycleAppendRecovery(append, ledger)).kind, 'not_found');
  const wrapped = recoveryRedis(raw);
  assert.equal(ledger.usesRedisClient(wrapped), true);
  assert.equal(new RedisQueueLedgerStore(wrapped).usesRedisClient(recoveryRedis(raw)), true);
  assert.equal(ledger.usesRedisClient(recoveryRedis(recoveryRedis(raw))), true);
  assert.equal(await raw.ping(), 'PONG');
});

test('the same database/prefix, an arbitrary lookalike proxy and duplicate connections never grant paired admission', async () => {
  const raw = owned.client('different:'),
    separate = owned.client('different:');
  const store = new RedisMessageStore(raw),
    foreign = new RedisQueueLedgerStore(separate);
  await assert.rejects(store.commitLifecycleWakeCoverage(coverage, foreign), /matching Redis Queue ledger/);
  await assert.rejects(store.commitLifecycleAppendRecovery(append, foreign), /matching Redis Queue ledger/);
  const ledger = new RedisQueueLedgerStore(raw),
    duplicate = recoveryRedis(raw).duplicate();
  try {
    assert.equal(ledger.usesRedisClient(duplicate), false);
    assert.equal(ledger.usesRedisClient(new Proxy(raw, {})), false);
    assert.equal(ledger.usesRedisClient(recoveryRedis(separate)), false);
    assert.equal(ledger.usesRedisClient(recoveryRedis(raw).multi()), false);
  } finally {
    duplicate.disconnect();
  }
});
