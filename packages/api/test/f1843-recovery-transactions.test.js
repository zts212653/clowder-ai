import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { taskProbeSource } from '../dist/domains/cats/services/stores/ports/TaskProbeSource.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { recoveryGuarded, withinRecoveryDeadline } from '../dist/infrastructure/recovery/recovery-deadline.js';
import { recoveryRedis } from '../dist/infrastructure/recovery/recovery-redis.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const fixture = ownedRedisFixture('1843-recovery-transactions');

test('a late WATCH read cannot start a new Task transaction, and its exclusive connection is disposed', async () => {
  const redis = fixture.client('watch:');
  const actual = new RedisTaskStore(redis);
  const task = await actual.create({
    threadId: 'home',
    title: 'probe',
    userId: 'owner',
    createdBy: 'codex61-sol',
    ownerCatId: 'codex61-sol',
    resolveMode: 'completes',
    probe: { kind: 'redis_exists', key: 'condition' },
  });
  await actual.update(task.id, { status: 'blocked' });
  const source = taskProbeSource(await actual.get(task.id));
  let release,
    enter,
    session,
    completion,
    lateWrite = false,
    ended = false,
    cleanupCalls = 0,
    disconnectCalls = 0,
    sessionEnded;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const injected = new Proxy(redis, {
    get(target, key) {
      if (key === 'duplicate')
        return (...args) => {
          session = target.duplicate(...args);
          sessionEnded = once(session, 'end', { signal: AbortSignal.timeout(1000) });
          const read = session.hgetall.bind(session),
            multi = session.multi.bind(session),
            unwatch = session.unwatch.bind(session),
            disconnect = session.disconnect.bind(session);
          session.disconnect = (...args) => {
            disconnectCalls++;
            return disconnect(...args);
          };
          session.hgetall = async (...args) => {
            const result = await read(...args);
            enter();
            await gate;
            return result;
          };
          session.multi = (...args) => {
            if (ended) lateWrite = true;
            return multi(...args);
          };
          session.unwatch = (...args) => {
            cleanupCalls++;
            return unwatch(...args);
          };
          return session;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const guarded = recoveryGuarded(new RedisTaskStore(injected));
  const bounded = withinRecoveryDeadline(
    performance.now() + 100,
    () => performance.now(),
    () => {
      completion = guarded.completeProbeIfCurrent(task.id, source);
      return completion;
    },
  );
  const rejection = assert.rejects(bounded, /recovery_deadline_exceeded/);
  try {
    await entered;
    await rejection;
    ended = true;
    assert.ok(disconnectCalls >= 1, 'the owned connection is disposed at deadline, before releasing the read');
  } finally {
    release();
    await completion.catch(() => {});
  }
  assert.equal(lateWrite, false);
  await sessionEnded;
  assert.equal(session.status, 'end');
  assert.equal(cleanupCalls, 1, 'unwatch is permitted even after the scope expires');
  assert.equal((await actual.get(task.id)).status, 'blocked');
  assert.equal(await redis.ping(), 'PONG', 'the shared owner connection remains usable');
});

test('fluent MULTI/pipeline builders retain their creating scope; valid transactions and disposal keep working', async () => {
  const raw = fixture.client('builders:');
  const redis = recoveryRedis(raw);
  for (const kind of ['multi', 'pipeline']) {
    let builder;
    await withinRecoveryDeadline(
      performance.now() + 1000,
      () => performance.now(),
      async () => {
        assert.deepEqual(await redis[kind]().set(`valid-${kind}`, 'yes').exec(), [[null, 'OK']]);
        builder = redis[kind]();
        assert.equal(builder.set(`late-${kind}`, 'forbidden'), builder);
      },
    );
    assert.throws(() => builder.exec(), /recovery_deadline_exceeded/);
    assert.equal(await raw.get(`late-${kind}`), null);
    assert.equal(await raw.get(`valid-${kind}`), 'yes');
  }
  let owned,
    ownedEnded,
    disposed = false;
  await withinRecoveryDeadline(
    performance.now() + 1000,
    () => performance.now(),
    async () => {
      owned = redis.duplicate();
      ownedEnded = once(owned, 'end', { signal: AbortSignal.timeout(1000) });
      const disconnect = owned.disconnect.bind(owned);
      owned.disconnect = (...args) => {
        disposed = true;
        return disconnect(...args);
      };
      assert.equal(await owned.ping(), 'PONG');
    },
  );
  assert.equal(disposed, true, 'scope disposal initiates disconnect before returning');
  await ownedEnded;
  assert.equal(owned.status, 'end');
  await owned.unwatch().catch(() => {});
  owned.disconnect();
  assert.equal(await raw.ping(), 'PONG');
});
