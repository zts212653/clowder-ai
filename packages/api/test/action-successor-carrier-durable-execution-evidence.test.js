/** Canonical Queue/History replacements for the original public durable evidence scenarios. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalActionFixture, refreshed, unavailable } from './helpers/canonical-action-history-fixtures.js';

const missing = unavailable('carrier_missing');
const holder = 'codex-sol';

test('canonical source → response → child → parent proves success without the key index', async () => {
  const f = await canonicalActionFixture();
  const { childId, parentId } = f.executions.get(holder);
  const calls = [];
  assert.deepEqual(
    await f.resolve({
      turnExecutionStore: {
        get: (id) => {
          calls.push(['child', id]);
          return f.turns.get(id);
        },
      },
      invocationRecordStore: {
        get: (id) => {
          calls.push(['parent', id]);
          return f.records.get(id);
        },
        getByIdempotencyKey: () => {
          throw Error('expired index must not be needed');
        },
      },
    }),
    refreshed(f),
  );
  assert.deepEqual(calls, [
    ['child', childId],
    ['parent', parentId],
  ]);
});

test('the exact response reference replaces receipt attempts and target outcomes', async () => {
  const f = await canonicalActionFixture();
  assert.equal(f.messages.getById(f.admitted.message.id).queueCustody, undefined);
  assert.deepEqual(await f.resolve(), refreshed(f));
});

test('an index hit cannot bypass canonical child and parent checks', async () => {
  const f = await canonicalActionFixture();
  let indexed = 0;
  let parents = 0;
  assert.deepEqual(
    await f.resolve({
      invocationRecordStore: {
        getByIdempotencyKey: () => {
          indexed++;
          return f.records.get(f.executions.get(holder).parentId);
        },
        get: (id) => {
          parents++;
          return f.records.get(id);
        },
      },
    }),
    refreshed(f),
  );
  assert.equal(indexed, 0);
  assert.equal(parents, 1);
});

test('a parent id supplied as a child cannot be used to read a parent record', async () => {
  const f = await canonicalActionFixture();
  const { parentId, responseId } = f.executions.get(holder);
  let reads = 0;
  assert.deepEqual(
    await f.resolve({
      messageStore: {
        getByThreadAfter: (...args) => f.messages.getByThreadAfter(...args),
        getById: (id) => {
          const m = f.messages.getById(id);
          return id === responseId ? { ...m, lifecycle: { ...m.lifecycle, invocationId: parentId } } : m;
        },
      },
      invocationRecordStore: {
        get: () => {
          reads++;
          throw Error('must not guess');
        },
      },
    }),
    missing,
  );
  assert.equal(reads, 0);
});

test('child id, holder, thread, owner and causal source must match before reading its parent', async () => {
  const f = await canonicalActionFixture();
  for (const drift of [
    { invocationId: 'other' },
    { catId: 'opus' },
    { threadId: 'other' },
    { userId: 'other' },
    { causal: { triggerMessageId: 'other' } },
  ]) {
    let parents = 0;
    assert.deepEqual(
      await f.resolve({
        turnExecutionStore: { get: (id) => ({ ...f.turns.get(id), ...drift }) },
        invocationRecordStore: {
          get: () => {
            parents++;
            throw Error('foreign child');
          },
        },
      }),
      missing,
      JSON.stringify(drift),
    );
    assert.equal(parents, 0);
  }
});

test('a missing child or parent is not evidence of delivered success', async () => {
  const f = await canonicalActionFixture();
  assert.deepEqual(await f.resolve({ turnExecutionStore: { get: () => null } }), missing);
  assert.deepEqual(await f.resolve({ invocationRecordStore: { get: () => null } }), missing);
});

test('without the child ledger no parent is guessed', async () => {
  const f = await canonicalActionFixture();
  let parents = 0;
  assert.deepEqual(
    await f.resolve({
      turnExecutionStore: undefined,
      invocationRecordStore: {
        get: () => {
          parents++;
          throw Error('no lineage');
        },
      },
    }),
    missing,
  );
  assert.equal(parents, 0);
});

test('foreign-generation, foreign-holder and ordinary keys cannot lend a run', async () => {
  const f = await canonicalActionFixture();
  for (const idempotencyKey of [
    'action-successor:action:lease-4058:2:codex-sol',
    'action-successor:action:lease-4058:1:opus',
    'ordinary-client-key',
  ])
    assert.deepEqual(
      await f.resolve({ invocationRecordStore: { get: (id) => ({ ...f.records.get(id), idempotencyKey }) } }),
      missing,
      idempotencyKey,
    );
});

test('parent owner, thread, id, target and immutable lease discriminator must match', async () => {
  const f = await canonicalActionFixture();
  for (const drift of [
    { userId: 'other' },
    { threadId: 'other' },
    { id: 'other' },
    { targetCats: ['opus'] },
    { actionLeaseCarrier: { kind: 'none' } },
    { actionLeaseCarrier: { kind: 'action_successor', leaseId: f.current.leaseId, generation: 2 } },
  ])
    assert.deepEqual(
      await f.resolve({ invocationRecordStore: { get: (id) => ({ ...f.records.get(id), ...drift }) } }),
      missing,
      JSON.stringify(drift),
    );
});

test('only successful terminal parent evidence for that holder refreshes; cancellation refuses', async () => {
  const f = await canonicalActionFixture();
  for (const drift of [
    { status: 'running' },
    { status: 'failed' },
    { successfulCatIds: undefined },
    { successfulCatIds: ['opus'] },
  ])
    assert.deepEqual(
      await f.resolve({ invocationRecordStore: { get: (id) => ({ ...f.records.get(id), ...drift }) } }),
      unavailable('execution_unconfirmed'),
      JSON.stringify(drift),
    );
  assert.deepEqual(
    await f.resolve({ invocationRecordStore: { get: (id) => ({ ...f.records.get(id), status: 'canceled' }) } }),
    unavailable('carrier_terminal'),
  );
});

test('a source without its exact response pointer cannot borrow an indexed run', async () => {
  const f = await canonicalActionFixture();
  let reads = 0;
  assert.deepEqual(
    await f.resolve({
      messageStore: {
        getByThreadAfter: async (...args) =>
          (await f.messages.getByThreadAfter(...args)).map((m) =>
            m.id === f.admitted.message.id ? { ...m, lifecycle: { ...m.lifecycle, dispatchRefs: [] } } : m,
          ),
        getById: (id) => f.messages.getById(id),
      },
      invocationRecordStore: {
        get: () => {
          reads++;
          throw Error('no pointer');
        },
      },
    }),
    missing,
  );
  assert.equal(reads, 0);
});

test('a previous generation cannot lend its History to a newer lease', async () => {
  const f = await canonicalActionFixture();
  assert.deepEqual(await f.resolve({ lease: { ...f.current, generation: 2, revision: 9 } }), missing);
});

test('throwing and rejecting Queue, History, child and parent faults exercise the intended dependency', async () => {
  const f = await canonicalActionFixture();
  for (const stage of ['queue', 'history', 'child', 'parent'])
    for (const rejects of [false, true]) {
      let calls = 0;
      const fail = () => {
        calls++;
        if (rejects) return Promise.reject(Error('intended failure'));
        throw Error('intended failure');
      };
      const change =
        stage === 'queue'
          ? { invocationQueue: { listAllDurable: fail } }
          : stage === 'history'
            ? { messageStore: { getByThreadAfter: fail, getById: (id) => f.messages.getById(id) } }
            : stage === 'child'
              ? { turnExecutionStore: { get: fail } }
              : { invocationRecordStore: { get: fail } };
      assert.deepEqual(await f.resolve(change), unavailable('lookup_failed'), stage);
      assert.equal(calls, 1, `${stage} fault must be reached`);
    }
});

test('parallel success requires all holders and leaves sibling History unchanged', async () => {
  const f = await canonicalActionFixture({
    leaseChanges: { mode: 'parallel', holderCatIds: [holder, 'opus'], parallelIntent: 'independent work' },
  });
  const before = structuredClone(f.messages.getById(f.admitted.message.id));
  assert.deepEqual(await f.resolve(), refreshed(f));
  assert.deepEqual(
    await f.resolve({ turnExecutionStore: { get: (id) => (id.endsWith('opus') ? null : f.turns.get(id)) } }),
    missing,
  );
  assert.deepEqual(f.messages.getById(f.admitted.message.id), before);
});

test('real five-minute index expiry retains the parent, child and History proof', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const f = await canonicalActionFixture({ legacyKey: true });
  const { parentId, childId } = f.executions.get(holder);
  const key = f.records.get(parentId).idempotencyKey;
  assert.equal(f.records.getByIdempotencyKey(f.current.holderThreadId, f.current.tenantScope, key)?.id, parentId);
  t.mock.timers.tick(301000);
  assert.equal(f.records.getByIdempotencyKey(f.current.holderThreadId, f.current.tenantScope, key), null);
  assert.equal(f.records.get(parentId)?.status, 'succeeded');
  assert.equal(f.records.get(childId), null);
  assert.deepEqual(await f.resolve(), refreshed(f));
});
