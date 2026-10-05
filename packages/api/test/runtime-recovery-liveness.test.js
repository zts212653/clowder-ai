import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ActionSuccessorDispatchRecovery } from '../dist/domains/ball-custody/ActionSuccessorDispatchRecovery.js';
import { ActionSuccessorRecoverySweep } from '../dist/domains/ball-custody/ActionSuccessorRecoverySweep.js';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { RedisGameStore } from '../dist/domains/cats/services/stores/redis/RedisGameStore.js';

test('recovery cycles coalesce census through completion and recover after a rejected cycle', async () => {
  for (const kind of ['returns', 'dispatches', 'managed']) {
    let scans = 0;
    let release;
    const pause = new Promise((resolve) => {
      release = resolve;
    });
    const scan = async () => {
      scans++;
      await pause;
      return [];
    };
    const sweep =
      kind === 'returns'
        ? new ActionSuccessorRecoverySweep({ leaseStore: { listPendingReturns: scan } })
        : kind === 'dispatches'
          ? new ActionSuccessorDispatchRecovery({ leaseStore: { listPendingDispatches: scan } })
          : new ManagedCommandWakeRecoverySweep({
              dynamicTaskStore: {
                getAll: () => {
                  scans++;
                  return [];
                },
              },
            });
    if (kind === 'managed') {
      // Hold the first asynchronous part of the entire cycle, before durable-job reconciliation.
      Object.assign(sweep, {
        recoverAdmissionFacts: async () => {
          await pause;
          return { scanned: 0, recovered: 0, pending: 0 };
        },
      });
    }
    const calls = Array.from({ length: 30 }, () => sweep.runOnce());
    await setImmediate();
    assert.equal(scans, 1, `${kind}: one census while 30 timer firings overlap`);
    release();
    const values = await Promise.all(calls);
    assert(values.every((value) => value === values[0]));
    await sweep.runOnce();
    assert.equal(scans, 2, `${kind}: next cycle is fresh`);
  }
  let attempts = 0;
  const sweep = new ActionSuccessorRecoverySweep({
    leaseStore: {
      listPendingReturns: async () => {
        if (++attempts === 1) throw new Error('temporary');
        return [];
      },
    },
  });
  await assert.rejects(sweep.runOnce(), /temporary/);
  assert.equal((await sweep.runOnce()).scanned, 0);
});
test('game recovery scans bounded pages, tolerates duplicates and empty pages, and batches reads', async () => {
  const calls = [];
  const redis = {
    options: { keyPrefix: 'fixture:' },
    keys: async () => {
      assert.fail('KEYS blocks the shared Redis event loop');
    },
    async scan(cursor, ...args) {
      calls.push([cursor, ...args]);
      if (cursor === '0') return ['4', []];
      if (cursor === '4') return ['7', ['fixture:game:thread:a:active', 'fixture:game:thread:b:active']];
      return ['0', ['fixture:game:thread:a:active', 'fixture:game:thread:c:active']];
    },
    async mget(...keys) {
      assert(keys.length <= 100);
      return keys.map((key) =>
        key.includes('thread:')
          ? ({ 'game:thread:a:active': 'ga', 'game:thread:b:active': null, 'game:thread:c:active': 'gc' }[key] ?? null)
          : JSON.stringify({ gameId: key.split(':').at(-1) }),
      );
    },
  };
  const games = await new RedisGameStore(redis).listActiveGames();
  assert.deepEqual(games.map((g) => g.gameId).sort(), ['ga', 'gc']);
  assert.equal(calls.length, 3);
  assert(calls.every((args) => args.includes('fixture:game:thread:*:active') && args.map(String).includes('100')));
});

test('ActionSuccessor timer coalesces all three owners until slow siblings settle after an early failure', async () => {
  const { createActionSuccessorRecoveryCycle } = await import(
    '../dist/domains/ball-custody/ActionSuccessorRecoveryCycle.js'
  );
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [0, 0, 0];
  let fail = true;
  const run = createActionSuccessorRecoveryCycle({
    recoverReturns: async () => {
      calls[0]++;
      if (fail) throw new Error('census unavailable');
      return { scanned: 0, delivered: 0, pending: 0, overdue: 0 };
    },
    recoverDispatches: async () => {
      calls[1]++;
      return { scanned: 0, delivered: 0, pending: 0, failed: 0 };
    },
    reconcileDoneTasks: async () => {
      calls[2]++;
      await slow;
      return { scanned: 0, attempted: 0, committed: 0, skipped: 0, errored: 0 };
    },
  });
  let settled = false;
  const first = run().catch((error) => {
    settled = true;
    return error;
  });
  await setImmediate();
  const queued = Array.from({ length: 30 }, () => run().catch((error) => error));
  await setImmediate();
  assert.equal(settled, false);
  assert.deepEqual(calls, [1, 1, 1]);
  release();
  assert((await first) instanceof AggregateError);
  assert(
    (await Promise.all(queued)).every((result) => result === undefined),
    'overlapping timer ticks produce no duplicate completion log',
  );
  fail = false;
  await run();
  assert.deepEqual(calls, [2, 2, 2]);
});
