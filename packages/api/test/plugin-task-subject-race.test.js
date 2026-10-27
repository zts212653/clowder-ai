import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Redis from 'ioredis';
import { withBallCustodyTaskEvents } from '../dist/domains/ball-custody/BallCustodyTaskStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { TaskKeys } from '../dist/domains/cats/services/stores/redis-keys/task-keys.js';
import { withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/task/plugin-task-host.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;

const conflict = { code: 'TASK_SUBJECT_SNAPSHOT_CONFLICT' };

async function fixture(t, backend) {
  if (backend === 'redis') assertRedisIsolationOrThrow(redisUrl, 'plugin-task-subject-race');
  const redis = backend === 'redis' ? new Redis(redisUrl, { keyPrefix: `subject-race:${randomUUID()}:` }) : null;
  if (redis) t.after(() => redis.quit());
  const store = redis ? new RedisTaskStore(redis) : new TaskStore();
  const threads = new ThreadStore();
  const keeper = threads.create('owner', 'Intake');
  const child = threads.create('owner', 'Implementation');
  threads.updateThreadKind(keeper.id, 'gate-keeping');
  const wrapped = withBallCustodyTaskEvents(store, { record: async () => {} });
  const host = createPluginTaskHost({
    pluginId: 'example',
    pluginInstanceId: 'instance',
    taskStore: wrapped,
    threadStore: threads,
  });
  const caller = {
    invocationId: 'inv',
    userId: 'owner',
    catId: 'codex',
    threadId: keeper.id,
    sourceMessageId: 'message',
    source: { kind: 'primary', sourceMessageId: 'message' },
    assertCurrent: async () => {},
  };
  const native = (run) => withPluginCallContext('instance', caller, run);
  const input = {
    threadId: keeper.id,
    title: 'Original',
    why: '',
    kind: 'work',
    subjectKey: 'subject:race',
    ownerCatId: 'codex',
    createdBy: 'system',
    userId: 'owner',
  };
  return { store, wrapped, redis, keeper, child, host, native, input };
}

for (const backend of ['memory', 'redis']) {
  const options = { skip: backend === 'redis' ? redisIsolationSkipReason(redisUrl) : false };
  for (const kind of ['pr_tracking', 'issue_tracking']) {
    test(
      `${backend}: authorize the actual subject winner (${kind}), including through custody wrapper`,
      options,
      async (t) => {
        const f = await fixture(t, backend);
        const original = f.store.upsertBySubject.bind(f.store);
        let winner;
        let before;
        f.store.upsertBySubject = async (...args) => {
          if (!winner) {
            winner = await f.store.create({
              ...f.input,
              kind,
              threadId: kind === 'issue_tracking' ? f.child.id : f.keeper.id,
            });
            before = structuredClone(await f.store.get(winner.id));
          }
          return original(...args);
        };
        await assert.rejects(
          f.native(() => f.host.create({ ...f.input, title: 'Unauthorized overwrite' }, { onConflict: 'update' })),
          /gate.keeping/i,
        );
        assert.deepEqual(await f.store.get(winner.id), before);
      },
    );
  }

  test(`${backend}: an absent snapshot cannot overwrite a concurrent subject`, options, async (t) => {
    const f = await fixture(t, backend);
    const winner = await f.store.create(f.input);
    const before = await f.store.get(winner.id);
    await assert.rejects(
      Promise.resolve().then(() => f.wrapped.upsertBySubject({ ...f.input, title: 'Stale' }, { expected: null })),
      conflict,
    );
    assert.deepEqual(await f.store.get(winner.id), before);
  });

  test(`${backend}: full snapshot rejects changes even with the same timestamp`, options, async (t) => {
    const f = await fixture(t, backend);
    const task = await f.store.create(f.input);
    const expected = structuredClone(await f.store.get(task.id));
    if (f.redis) await f.redis.hset(TaskKeys.detail(task.id), 'ownerCatId', 'opus');
    else f.store.get(task.id).ownerCatId = 'opus';
    const before = structuredClone(await f.store.get(task.id));
    assert.equal(before.updatedAt, expected.updatedAt);
    await assert.rejects(
      Promise.resolve().then(() => f.store.upsertBySubject({ ...f.input, title: 'Stale' }, { expected })),
      conflict,
    );
    assert.deepEqual(await f.store.get(task.id), before);
  });

  test(`${backend}: uncontended keeper issue creation and replay remain available`, options, async (t) => {
    const f = await fixture(t, backend);
    const input = { ...f.input, kind: 'issue_tracking' };
    const first = await f.native(() => f.host.create(input, { onConflict: 'update' }));
    const next = await f.native(() => f.host.create({ ...input, title: 'Replay' }, { onConflict: 'update' }));
    assert.equal(next.id, first.id);
    assert.equal(next.title, 'Replay');
  });

  test(`${backend}: retry exhaustion fails closed without an unfenced write`, options, async (t) => {
    const f = await fixture(t, backend);
    const task = await f.store.create(f.input);
    const original = f.store.upsertBySubject.bind(f.store);
    let calls = 0;
    f.store.upsertBySubject = async (...args) => {
      calls++;
      await f.store.update(task.id, { title: `Concurrent ${calls}` });
      return original(...args);
    };
    await assert.rejects(
      f.native(() => f.host.create({ ...f.input, title: 'Stale' }, { onConflict: 'update' })),
      conflict,
    );
    assert.equal(calls, 3);
    assert.equal((await f.store.get(task.id)).title, 'Concurrent 3');
  });
}

test(
  'redis: a write after snapshot comparison aborts the watched transaction',
  {
    skip: redisIsolationSkipReason(redisUrl),
  },
  async (t) => {
    const f = await fixture(t, 'redis');
    const task = await f.store.create(f.input);
    const expected = await f.store.get(task.id);
    const duplicate = f.redis.duplicate.bind(f.redis);
    let injected = false;
    f.redis.duplicate = (...args) => {
      const session = duplicate(...args);
      const multi = session.multi.bind(session);
      session.multi = (...multiArgs) => {
        const tx = multi(...multiArgs);
        const exec = tx.exec.bind(tx);
        tx.exec = async () => {
          if (!injected) {
            injected = true;
            await f.redis.hset(TaskKeys.detail(task.id), 'ownerCatId', 'opus');
          }
          return exec();
        };
        return tx;
      };
      return session;
    };
    await assert.rejects(f.store.upsertBySubject({ ...f.input, title: 'Stale' }, { expected }), conflict);
    assert.equal(injected, true);
    const after = await f.store.get(task.id);
    assert.equal(after.ownerCatId, 'opus');
    assert.equal(after.title, 'Original');
    assert.equal(after.updatedAt, expected.updatedAt);
  },
);

test(
  'redis: concurrent creation after the absence check preserves the canonical winner',
  {
    skip: redisIsolationSkipReason(redisUrl),
  },
  async (t) => {
    const f = await fixture(t, 'redis');
    const duplicate = f.redis.duplicate.bind(f.redis);
    let winner;
    f.redis.duplicate = (...args) => {
      const session = duplicate(...args);
      const multi = session.multi.bind(session);
      session.multi = (...multiArgs) => {
        const tx = multi(...multiArgs);
        const exec = tx.exec.bind(tx);
        tx.exec = async () => {
          if (!winner) winner = await f.store.create({ ...f.input, kind: 'pr_tracking' });
          return exec();
        };
        return tx;
      };
      return session;
    };
    await assert.rejects(f.store.upsertBySubject({ ...f.input, title: 'Stale' }, { expected: null }), conflict);
    const after = await f.store.getBySubject(f.input.subjectKey);
    assert.equal(after.id, winner.id);
    assert.equal(after.kind, 'pr_tracking');
    assert.equal(after.title, 'Original');
    assert.equal((await f.store.listByThread(f.keeper.id)).length, 1);
  },
);
