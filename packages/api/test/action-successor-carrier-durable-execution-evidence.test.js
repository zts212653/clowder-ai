/**
 * F167 carrier refresh — the execution evidence must outlive the 5-minute idempotency index.
 *
 * Production case (2026-10-02): lease 72bf1545 had been handled on 2026-09-24. The exact refresh request
 * answered 409 `execution_unconfirmed`, because the recognition looked the old run up ONLY through
 * `getByIdempotencyKey`, an index both stores expire after 5 minutes while the InvocationRecord stays.
 *
 * What custody durably names is NOT that record. The Queue creates a PARENT InvocationRecord from the carrier
 * key, the cat's turn runs as a CHILD, and custody (the F264 target outcome, the handled attempt) names the
 * child. The durable TurnExecution ledger links child to parent. So the evidence is followed child -> parent,
 * every link is checked, and the parent must still be the record created from this exact carrier key.
 * Fixtures here therefore name a CHILD id in custody and keep the parent record under its own id.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { resolveDirectActionSuccessorCarrier } from '../dist/domains/ball-custody/DirectActionSuccessorCarrierRecovery.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  carrier,
  child,
  childInvocationId,
  lease,
  oldInvocationKey,
  record,
  recordStore,
  request,
  turnStore,
} from './helpers/direct-action-carrier-fixtures.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function resolve(current, messages, store, lineage, overrides = {}) {
  return resolveDirectActionSuccessorCarrier({
    lease: current,
    admissionInput: request(current, overrides),
    messageStore: { getByThreadAfter: async () => messages },
    invocationRecordStore: store,
    turnExecutionStore: lineage,
  });
}

/** A handled carrier whose only durable pointer to the run is the F264 target outcome (a CHILD id). */
function handledByOutcome(current, catId, invocationId) {
  const message = carrier(current, catId, 'handled');
  message.queueCustody.targetAttempts = [];
  message.queueCustody.targetOutcomeByCatId = {
    [catId]: {
      invocationId,
      disposition: 'responded',
      evidenceRef: { kind: 'invocation_lineage', invocationId },
      handledAt: 130,
    },
  };
  return message;
}

/** The key index has expired (as it does after 5 minutes); only the persistent parent record by id remains. */
function expiredIndex(parents, options) {
  return recordStore(new Map(), { ...options, byId: new Map(parents.map((value) => [value.id, value])) });
}

const refreshable = (current) => ({
  disposition: 'refresh_handled',
  fence: buildActionSuccessorFence(current, current.dispatchId),
});
const unconfirmed = { disposition: 'unavailable', reason: 'execution_unconfirmed' };
const handled = (current) => [carrier(current, 'codex-sol', 'handled')];

describe('F167 refresh confirms the old run through the durable child -> parent lineage', () => {
  test('the handled attempt names the child; its parent record proves the run, though the key index has expired', async () => {
    const current = lease();
    const store = expiredIndex([record(current, 'codex-sol')]);
    const lineage = turnStore([child(current, 'codex-sol')]);
    assert.deepEqual(await resolve(current, handled(current), store, lineage), refreshable(current));
    // The exact key is tried first; custody's child id is read from the ledger, and only ITS PARENT is read as a record.
    assert.deepEqual(store.log, ['key', 'id']);
    assert.deepEqual(lineage.calls, [childInvocationId('codex-sol')]);
    assert.deepEqual(store.idCalls, ['invocation-codex-sol']);
  });

  test('the F264 target outcome alone is enough, with the same lineage', async () => {
    const current = lease();
    const decision = await resolve(
      current,
      [handledByOutcome(current, 'codex-sol', childInvocationId('codex-sol'))],
      expiredIndex([record(current, 'codex-sol')]),
      turnStore([child(current, 'codex-sol')]),
    );
    assert.deepEqual(decision, refreshable(current));
  });

  test('a hit on the exact key still decides, and the ledger is not consulted', async () => {
    const current = lease();
    const store = recordStore(new Map([[oldInvocationKey(current, 'codex-sol'), record(current, 'codex-sol')]]));
    const lineage = turnStore([child(current, 'codex-sol')]);
    assert.deepEqual(await resolve(current, handled(current), store, lineage), refreshable(current));
    assert.deepEqual(store.log, ['key']);
    assert.deepEqual(lineage.calls, []);
  });

  test('custody never names the record itself: a pointer that is a parent record id is not read as a record', async () => {
    const current = lease();
    const store = expiredIndex([record(current, 'codex-sol')]);
    const message = handledByOutcome(current, 'codex-sol', 'invocation-codex-sol'); // the PARENT record id
    assert.deepEqual(await resolve(current, [message], store, turnStore([child(current, 'codex-sol')])), unconfirmed);
    assert.deepEqual(store.idCalls, [], 'no record is ever read by a custody-supplied id');
  });

  test('the child must be exactly that run of that holder, in that thread and tenant', async () => {
    const current = lease();
    const wrong = {
      'a ledger entry for another id': { invocationId: 'child-other' },
      'another cat': { catId: 'opus' },
      'another thread': { threadId: 'thread-elsewhere' },
      'another tenant': { userId: 'user-2' },
    };
    for (const [name, change] of Object.entries(wrong)) {
      const store = expiredIndex([record(current, 'codex-sol')]);
      const lineage = turnStore([child(current, 'codex-sol')]);
      lineage.get = (id) => {
        lineage.calls.push(id);
        return child(current, 'codex-sol', change);
      };
      assert.deepEqual(await resolve(current, handled(current), store, lineage), unconfirmed, name);
      assert.deepEqual(store.idCalls, [], `${name}: the parent is not read for a child that is not this run`);
    }
  });

  test('a missing child, or a child whose parent record is gone, stays execution_unconfirmed', async () => {
    const current = lease();
    assert.deepEqual(
      await resolve(current, handled(current), expiredIndex([record(current, 'codex-sol')]), turnStore([])),
      unconfirmed,
    );
    assert.deepEqual(
      await resolve(current, handled(current), expiredIndex([]), turnStore([child(current, 'codex-sol')])),
      unconfirmed,
    );
  });

  test('without the child ledger a pointer cannot be followed, so nothing is confirmed and no record is read by id', async () => {
    const current = lease();
    const store = expiredIndex([record(current, 'codex-sol')]);
    assert.deepEqual(await resolve(current, handled(current), store, undefined), unconfirmed);
    assert.deepEqual(store.log, ['key']);
  });

  test('a parent record that is not bound to THIS carrier key is never evidence', async () => {
    const current = lease();
    const other = lease({ generation: 2, revision: 9 });
    const wrongKeys = {
      'another generation': oldInvocationKey(other, 'codex-sol'),
      'another cat': oldInvocationKey(current, 'opus'),
      'an ordinary client key': 'client-supplied-key',
    };
    for (const [name, idempotencyKey] of Object.entries(wrongKeys)) {
      const decision = await resolve(
        current,
        handled(current),
        expiredIndex([record(current, 'codex-sol', { idempotencyKey })]),
        turnStore([child(current, 'codex-sol')]),
      );
      assert.deepEqual(decision, unconfirmed, name);
    }
  });

  test('a parent record from another thread or tenant is never evidence', async () => {
    const current = lease();
    for (const change of [{ threadId: 'thread-elsewhere' }, { userId: 'user-2' }]) {
      const decision = await resolve(
        current,
        handled(current),
        expiredIndex([record(current, 'codex-sol', change)]),
        turnStore([child(current, 'codex-sol')]),
      );
      assert.deepEqual(decision, unconfirmed, JSON.stringify(change));
    }
  });

  test('the parent is judged exactly like an indexed one: only a settled success for that target refreshes', async () => {
    const current = lease();
    const lineage = () => turnStore([child(current, 'codex-sol')]);
    const cases = {
      running: record(current, 'codex-sol', { status: 'running', successfulCatIds: undefined }),
      failed: record(current, 'codex-sol', { status: 'failed', successfulCatIds: [] }),
      'succeeded without per-target evidence': record(current, 'codex-sol', { successfulCatIds: undefined }),
      'succeeded for another cat': record(current, 'codex-sol', { successfulCatIds: ['someone-else'] }),
    };
    for (const [name, value] of Object.entries(cases)) {
      assert.deepEqual(await resolve(current, handled(current), expiredIndex([value]), lineage()), unconfirmed, name);
    }
    const canceled = record(current, 'codex-sol', { status: 'canceled', successfulCatIds: undefined });
    assert.deepEqual(await resolve(current, handled(current), expiredIndex([canceled]), lineage()), {
      disposition: 'unavailable',
      reason: 'carrier_terminal',
    });
  });

  test('a carrier with no durable pointer (legacy handled custody) stays execution_unconfirmed and reads nothing', async () => {
    const current = lease();
    const noPointer = carrier(current, 'codex-sol', 'handled');
    noPointer.queueCustody.targetAttempts = [];
    const store = expiredIndex([record(current, 'codex-sol')]);
    const lineage = turnStore([child(current, 'codex-sol')]);
    assert.deepEqual(await resolve(current, [noPointer], store, lineage), unconfirmed);
    assert.deepEqual(store.log, ['key']);
    assert.deepEqual(lineage.calls, []);
  });

  test('a carrier of another generation does not lend its pointers to this one', async () => {
    const current = lease({ generation: 2, revision: 9 });
    const old = lease();
    const store = expiredIndex([record(old, 'codex-sol')]);
    const lineage = turnStore([child(old, 'codex-sol')]);
    const decision = await resolve(current, [carrier(old, 'codex-sol', 'handled')], store, lineage);
    assert.deepEqual(decision, { disposition: 'unavailable', reason: 'carrier_missing' });
    assert.deepEqual(store.calls, []);
    assert.deepEqual(lineage.calls, []);
  });

  test('a failing ledger or record read is an explicit lookup_failed, not unconfirmed', async () => {
    const current = lease();
    const failing = [
      ['ledger throws', expiredIndex([record(current, 'codex-sol')]), turnStore([], { throws: true })],
      ['ledger rejects', expiredIndex([record(current, 'codex-sol')]), turnStore([], { rejects: true })],
      [
        'record throws',
        expiredIndex([record(current, 'codex-sol')], { idThrows: true }),
        turnStore([child(current, 'codex-sol')]),
      ],
      [
        'record rejects',
        expiredIndex([record(current, 'codex-sol')], { idRejects: true }),
        turnStore([child(current, 'codex-sol')]),
      ],
    ];
    for (const [name, store, lineage] of failing) {
      const decision = await resolve(current, handled(current), store, lineage);
      assert.deepEqual(decision, { disposition: 'unavailable', reason: 'lookup_failed' }, name);
    }
  });

  test('parallel holders: each is confirmed by whichever exact evidence it has, and one gap blocks the refresh', async () => {
    const parallel = lease({
      mode: 'parallel',
      holderCatIds: ['codex-sol', 'opus'],
      parallelIntent: 'independent implementation',
    });
    const asked = { action: { ...request(parallel).action, parallelIntent: 'independent implementation' } };
    const messages = [carrier(parallel, 'codex-sol', 'handled'), carrier(parallel, 'opus', 'handled')];
    const lineage = turnStore([child(parallel, 'codex-sol'), child(parallel, 'opus')]);
    const mixed = recordStore(new Map([[oldInvocationKey(parallel, 'codex-sol'), record(parallel, 'codex-sol')]]), {
      byId: new Map([['invocation-opus', record(parallel, 'opus')]]),
    });
    assert.equal((await resolve(parallel, messages, mixed, lineage, asked)).disposition, 'refresh_handled');

    const gap = expiredIndex([record(parallel, 'codex-sol')]);
    assert.deepEqual(await resolve(parallel, messages, gap, lineage, asked), unconfirmed);
  });
});

describe('F167 the same recognition against the real stores once the index has expired', () => {
  test('after 5 minutes the key index is gone but the parent record and the child ledger are not', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const current = lease();
    const records = new InvocationRecordStore();
    const turns = new InMemoryTurnExecutionStore();
    const key = oldInvocationKey(current, 'codex-sol');
    // What the Queue creates: a PARENT record from the carrier key, and the cat's turn as a CHILD of it.
    const parent = records.create({
      threadId: current.holderThreadId,
      userId: current.tenantScope,
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: key,
      actionLeaseCarrier: { kind: 'action_successor', leaseId: current.leaseId, generation: current.generation },
    }).invocationId;
    turns.createRunning({
      invocationId: 'real-child-turn',
      parentInvocationId: parent,
      threadId: current.holderThreadId,
      userId: current.tenantScope,
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    turns.transitionTerminal('real-child-turn', { status: 'succeeded', endedAt: Date.now() });
    records.update(parent, { status: 'running' });
    records.update(parent, { status: 'succeeded', successfulCatIds: ['codex-sol'] });

    assert.equal(records.getByIdempotencyKey(current.holderThreadId, current.tenantScope, key)?.status, 'succeeded');
    t.mock.timers.tick(FIVE_MINUTES_MS + 1_000);
    // The mechanism behind the production 409: the index expired, the record did not.
    assert.equal(records.getByIdempotencyKey(current.holderThreadId, current.tenantScope, key), null);
    assert.equal(records.get(parent)?.status, 'succeeded');
    assert.equal(records.get('real-child-turn'), null, 'custody names the child, which is not an InvocationRecord');

    const message = carrier(current, 'codex-sol', 'handled');
    message.queueCustody.targetAttempts[0].invocationId = 'real-child-turn';
    assert.deepEqual(await resolve(current, [message], records, turns), refreshable(current));
  });
});
