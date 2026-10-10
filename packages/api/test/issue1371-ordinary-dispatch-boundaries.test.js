import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { ordinaryDispatchFixture } from './helpers/ordinary-dispatch-fixture.js';

for (const boundary of [
  'unread',
  'preview',
  'wrong-token',
  'foreign-invocation',
  'terminal',
  'stale',
  'missing-active-run',
  'withdrawn',
]) {
  test('ordinary input remains undelivered at the ' + boundary + ' boundary', async (t) => {
    const f = await ordinaryDispatchFixture(t);
    const path = '/api/callbacks/get-message?messageId=' + f.message.id + '&mode=full';
    if (boundary === 'preview') {
      assert.equal((await f.get(path.replace('mode=full', 'mode=preview'))).statusCode, 200);
    } else if (boundary === 'wrong-token') {
      assert.equal((await f.get(path, { ...f.headers, 'x-callback-token': 'foreign' })).statusCode, 401);
    } else if (boundary === 'foreign-invocation') {
      const other = await f.registry.create('other-owner', 'kimi', 'foreign-thread');
      const result = await f.get(path, {
        'x-invocation-id': other.invocationId,
        'x-callback-token': other.callbackToken,
      });
      assert.ok(result.statusCode >= 400, result.body);
    } else if (boundary === 'terminal') {
      f.turns.transitionTerminal(f.auth.invocationId, {
        status: 'failed',
        terminalReason: 'fixture_failure',
        endedAt: Date.now(),
      });
      assert.ok((await f.get(path)).statusCode >= 400);
    } else if (boundary === 'stale') {
      await f.registry.create('owner', 'codex-astra', 'home', 'replacement-parent');
      assert.ok((await f.get(path)).statusCode >= 400);
    } else if (boundary === 'missing-active-run') {
      f.tracker.completeByExecutionId('home', 'codex-astra', 'live-parent');
      assert.ok((await f.get(path)).statusCode >= 400);
    } else if (boundary === 'withdrawn') {
      const claim = await f.queue.claimMessageEntriesForWithdrawal('home', 'owner', f.message.id);
      assert.equal(claim.outcome, 'claimed');
      f.store.markCanceled(f.message.id);
      assert.equal(
        await f.queue.commitClaimedMessageWithdrawal(
          'home',
          claim.entries.map((e) => e.id),
        ),
        true,
      );
      await f.get(path);
    }
    assert.equal(f.store.getById(f.message.id).lifecycle.dispatchRefs?.length ?? 0, 0);
    assert.equal(f.store.getById(f.response.id).lifecycle.inputRefs?.length ?? 0, 0);
    assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
    const pending = f.queue.list('home', 'owner');
    assert.equal(pending.length, boundary === 'withdrawn' ? 0 : 1);
  });
}

test('ordinary admission with a lost durable reply heals from the same response and leaves its late input pending', async (t) => {
  const f = await ordinaryDispatchFixture(t);
  const commit = f.store.commitLifecycleAppendAdmission.bind(f.store);
  f.store.commitLifecycleAppendAdmission = async (input) => {
    await commit(input);
    throw new Error('fixture lost admission acknowledgement');
  };
  assert.equal((await f.read()).statusCode, 503);
  const late = await f.addSource('late pending input');
  const restarted = new InvocationQueue(f.ledgerStore);
  await restarted.hydrateFromLedger(f.store);
  assert.deepEqual(
    restarted.list('home', 'owner').map((e) => e.payload.messageId),
    [late.id],
  );
  assert.equal(f.store.getById(f.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  f.store.commitLifecycleAppendAdmission = commit;
  assert.equal((await f.read()).statusCode, 200);
  assert.equal(f.store.getById(f.message.id).lifecycle.dispatchRefs.length, 1);
  assert.equal(f.store.getById(late.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.deepEqual(f.queue.list('home', 'owner'), []);
});
