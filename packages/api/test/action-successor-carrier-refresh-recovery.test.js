import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalActionFixture, refreshed, unavailable } from './helpers/canonical-action-history-fixtures.js';

test('completed canonical History refreshes only the exact target', async () => {
  const f = await canonicalActionFixture();
  assert.deepEqual(await f.resolve(), refreshed(f));
});

test('missing bound parent cannot prove refresh or terminal success', async () => {
  const f = await canonicalActionFixture();
  assert.deepEqual(await f.resolve({ invocationRecordStore: { get: () => null } }), unavailable('carrier_missing'));
});

test('running, queued, failed and missing per-target parent success cannot prove completion', async () => {
  const f = await canonicalActionFixture();
  for (const drift of [
    { status: 'running' },
    { status: 'queued' },
    { status: 'failed' },
    { successfulCatIds: undefined },
    { successfulCatIds: ['opus'] },
  ])
    assert.deepEqual(
      await f.resolve({ invocationRecordStore: { get: (id) => ({ ...f.records.get(id), ...drift }) } }),
      unavailable('execution_unconfirmed'),
      JSON.stringify(drift),
    );
});

test('explicit cancellation is terminal and never refreshes', async () => {
  const f = await canonicalActionFixture({ status: 'canceled' });
  assert.deepEqual(await f.resolve(), unavailable('carrier_terminal'));
});

test('canceled History defeats a stale pending snapshot', async () => {
  const f = await canonicalActionFixture({ status: 'canceled' });
  assert.deepEqual(
    await f.resolve({ invocationQueue: { listAllDurable: async () => [f.admitted.entry] } }),
    unavailable('carrier_terminal'),
  );
});

test('pending, interrupted, failed and missing sources keep distinct decisions', async () => {
  for (const [status, result] of [
    ['pending', 'live'],
    ['interrupted', 'restart_interrupted'],
    ['failed', 'carrier_failed'],
  ]) {
    const f = await canonicalActionFixture({ status });
    assert.deepEqual(
      await f.resolve(),
      ['live', 'restart_interrupted'].includes(result) ? { disposition: result, fence: f.fence } : unavailable(result),
    );
  }
  const f = await canonicalActionFixture();
  assert.deepEqual(
    await f.resolve({ messageStore: { getByThreadAfter: async () => [], getById: () => null } }),
    unavailable('carrier_missing'),
  );
});

test('throwing and rejecting record lookup really call the record dependency', async () => {
  const f = await canonicalActionFixture();
  for (const rejects of [false, true]) {
    let calls = 0;
    assert.deepEqual(
      await f.resolve({
        invocationRecordStore: {
          get: () => {
            calls++;
            if (rejects) return Promise.reject(Error('record failure'));
            throw Error('record failure');
          },
        },
      }),
      unavailable('lookup_failed'),
    );
    assert.equal(calls, 1);
  }
});

test('request authority mismatch reads no Queue, History or execution dependencies', async () => {
  const f = await canonicalActionFixture();
  let calls = 0;
  const fail = () => {
    calls++;
    throw Error('must not consult');
  };
  for (const change of [{ actorCatId: 'opus' }, { targetThreadId: 'other' }, { holderCatIds: ['kimi'] }])
    assert.deepEqual(
      await f.resolve(
        {
          invocationQueue: { listAllDurable: fail },
          messageStore: { getByThreadAfter: fail, getById: fail },
          invocationRecordStore: { get: fail },
          turnExecutionStore: { get: fail },
        },
        change,
      ),
      unavailable('authority_mismatch'),
    );
  assert.equal(calls, 0);
});

test('another generation cannot lend its delivered source and execution', async () => {
  const f = await canonicalActionFixture();
  assert.deepEqual(
    await f.resolve({ lease: { ...f.current, generation: 2, revision: 9 } }),
    unavailable('carrier_missing'),
  );
});

test('parallel success requires every holder; live mix and missing proof refuse refresh', async () => {
  const f = await canonicalActionFixture({
    leaseChanges: { mode: 'parallel', holderCatIds: ['codex-sol', 'opus'], parallelIntent: 'independent work' },
  });
  assert.deepEqual(await f.resolve(), refreshed(f));
  const opus = f.executions.get('opus');
  assert.deepEqual(
    await f.resolve({
      messageStore: {
        getByThreadAfter: (...args) => f.messages.getByThreadAfter(...args),
        getById: (id) => {
          const m = f.messages.getById(id);
          return id === opus.responseId ? { ...m, lifecycle: { ...m.lifecycle, status: 'processing' } } : m;
        },
      },
      turnExecutionStore: {
        get: (id) => (id === opus.childId ? { ...f.turns.get(id), status: 'running' } : f.turns.get(id)),
      },
      invocationRecordStore: {
        get: (id) => (id === opus.parentId ? { ...f.records.get(id), status: 'running' } : f.records.get(id)),
      },
    }),
    unavailable('carrier_mixed'),
  );
  assert.deepEqual(
    await f.resolve({ invocationRecordStore: { get: (id) => (id === opus.parentId ? null : f.records.get(id)) } }),
    unavailable('carrier_missing'),
  );
});
