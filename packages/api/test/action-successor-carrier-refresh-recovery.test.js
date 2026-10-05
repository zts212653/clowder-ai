/**
 * F167 carrier refresh — recognising a refreshable carrier.
 *
 * `handled` is a message-custody fact ("this target consumed its source"). It does not by itself
 * prove the provider execution ended, and it cannot tell a normal completion from an explicit
 * cancel. A handled carrier is refreshable only when the InvocationRecord created from the very same
 * carrier key independently shows a successful terminal execution for that exact target.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { resolveDirectActionSuccessorCarrier } from '../dist/domains/ball-custody/DirectActionSuccessorCarrierRecovery.js';
import {
  carrier,
  lease,
  oldInvocationKey,
  record,
  recordStore,
  request,
} from './helpers/direct-action-carrier-fixtures.js';

function resolve(current, messages, store, overrides = {}) {
  return resolveDirectActionSuccessorCarrier({
    lease: current,
    admissionInput: request(current, overrides),
    messageStore: { getByThreadAfter: async () => messages },
    invocationRecordStore: store,
  });
}

describe('F167 refreshable handled carrier', () => {
  test('a handled carrier whose own InvocationRecord succeeded for that exact target is refresh_handled', async () => {
    const current = lease();
    const store = recordStore(new Map([[oldInvocationKey(current, 'codex-sol'), record(current, 'codex-sol')]]));

    const decision = await resolve(current, [carrier(current, 'codex-sol', 'handled')], store);

    assert.deepEqual(decision, {
      disposition: 'refresh_handled',
      fence: buildActionSuccessorFence(current, current.dispatchId),
    });
    // The record is looked up by the exact carrier-derived key, scoped to the holder thread and tenant.
    assert.deepEqual(store.calls, [
      { threadId: 'thread-holder', userId: 'user-1', key: oldInvocationKey(current, 'codex-sol') },
    ]);
  });

  test('handled alone is not enough: a missing record is execution_unconfirmed, never terminal and never refreshable', async () => {
    const current = lease();
    const decision = await resolve(current, [carrier(current, 'codex-sol', 'handled')], recordStore(new Map()));
    assert.deepEqual(decision, { disposition: 'unavailable', reason: 'execution_unconfirmed' });
  });

  test('an execution that is not a settled success is execution_unconfirmed (still running, replayable, or no per-target proof)', async () => {
    const current = lease();
    const key = oldInvocationKey(current, 'codex-sol');
    const cases = {
      running: record(current, 'codex-sol', { status: 'running', successfulCatIds: undefined }),
      queued: record(current, 'codex-sol', { status: 'queued', successfulCatIds: undefined }),
      failed: record(current, 'codex-sol', { status: 'failed', successfulCatIds: [] }),
      'succeeded without per-target evidence': record(current, 'codex-sol', { successfulCatIds: undefined }),
      'succeeded for another cat': record(current, 'codex-sol', { successfulCatIds: ['someone-else'] }),
    };
    for (const [name, value] of Object.entries(cases)) {
      const decision = await resolve(
        current,
        [carrier(current, 'codex-sol', 'handled')],
        recordStore(new Map([[key, value]])),
      );
      assert.deepEqual(decision, { disposition: 'unavailable', reason: 'execution_unconfirmed' }, name);
    }
  });

  test('an explicitly canceled execution is terminal, not refreshable', async () => {
    const current = lease();
    const key = oldInvocationKey(current, 'codex-sol');
    const canceled = record(current, 'codex-sol', { status: 'canceled', successfulCatIds: undefined });
    const decision = await resolve(
      current,
      [carrier(current, 'codex-sol', 'handled')],
      recordStore(new Map([[key, canceled]])),
    );
    assert.deepEqual(decision, { disposition: 'unavailable', reason: 'carrier_terminal' });
  });

  test('a withdrawn carrier stays carrier_terminal and never even consults the execution record', async () => {
    const current = lease();
    const store = recordStore(new Map([[oldInvocationKey(current, 'codex-sol'), record(current, 'codex-sol')]]));
    const decision = await resolve(current, [carrier(current, 'codex-sol', 'withdrawn')], store);
    assert.deepEqual(decision, { disposition: 'unavailable', reason: 'carrier_terminal' });
    assert.deepEqual(store.calls, []);
  });

  test('live, interrupted and failed carriers keep their existing decisions without consulting the record', async () => {
    const current = lease();
    const store = recordStore(new Map());
    const fence = buildActionSuccessorFence(current, current.dispatchId);
    assert.deepEqual(await resolve(current, [carrier(current, 'codex-sol', 'queued')], store), {
      disposition: 'live',
      fence,
    });
    assert.deepEqual(await resolve(current, [carrier(current, 'codex-sol', 'failed')], store), {
      disposition: 'unavailable',
      reason: 'carrier_failed',
    });
    assert.deepEqual(await resolve(current, [], store), { disposition: 'unavailable', reason: 'carrier_missing' });
    assert.deepEqual(store.calls, []);
  });

  test('a failing record lookup is an explicit lookup_failed, whether it throws or rejects', async () => {
    const current = lease();
    for (const options of [{ throws: true }, { rejects: true }]) {
      const decision = await resolve(
        current,
        [carrier(current, 'codex-sol', 'handled')],
        recordStore(new Map(), options),
      );
      assert.deepEqual(decision, { disposition: 'unavailable', reason: 'lookup_failed' }, JSON.stringify(options));
    }
  });

  test('without exact request authority nothing is consulted and nothing is refreshable', async () => {
    const current = lease();
    const store = recordStore(new Map([[oldInvocationKey(current, 'codex-sol'), record(current, 'codex-sol')]]));
    for (const change of [{ actorCatId: 'opus' }, { targetThreadId: 'thread-other' }, { holderCatIds: ['kimi'] }]) {
      const decision = await resolve(current, [carrier(current, 'codex-sol', 'handled')], store, change);
      assert.deepEqual(decision, { disposition: 'unavailable', reason: 'authority_mismatch' }, JSON.stringify(change));
    }
    assert.deepEqual(store.calls, []);
  });

  test('a handled carrier of another generation is not evidence for this one', async () => {
    const current = lease({ generation: 2, revision: 9 });
    const old = lease();
    const store = recordStore(new Map([[oldInvocationKey(old, 'codex-sol'), record(old, 'codex-sol')]]));
    const decision = await resolve(current, [carrier(old, 'codex-sol', 'handled')], store);
    assert.deepEqual(decision, { disposition: 'unavailable', reason: 'carrier_missing' });
    assert.deepEqual(store.calls, []);
  });

  test('parallel holders refresh only when EVERY holder is handled and confirmed; one live holder blocks it', async () => {
    const parallel = lease({
      mode: 'parallel',
      holderCatIds: ['codex-sol', 'opus'],
      parallelIntent: 'independent implementation',
    });
    const asked = { action: { ...request(parallel).action, parallelIntent: 'independent implementation' } };
    const both = new Map(['codex-sol', 'opus'].map((cat) => [oldInvocationKey(parallel, cat), record(parallel, cat)]));

    const ok = await resolve(
      parallel,
      [carrier(parallel, 'codex-sol', 'handled'), carrier(parallel, 'opus', 'handled')],
      recordStore(both),
      asked,
    );
    assert.equal(ok.disposition, 'refresh_handled');

    const oneLive = await resolve(
      parallel,
      [carrier(parallel, 'codex-sol', 'handled'), carrier(parallel, 'opus', 'queued')],
      recordStore(both),
      asked,
    );
    assert.deepEqual(oneLive, { disposition: 'unavailable', reason: 'carrier_terminal' });

    const oneUnconfirmed = await resolve(
      parallel,
      [carrier(parallel, 'codex-sol', 'handled'), carrier(parallel, 'opus', 'handled')],
      recordStore(new Map([[oldInvocationKey(parallel, 'codex-sol'), record(parallel, 'codex-sol')]])),
      asked,
    );
    assert.deepEqual(oneUnconfirmed, { disposition: 'unavailable', reason: 'execution_unconfirmed' });
  });
});
