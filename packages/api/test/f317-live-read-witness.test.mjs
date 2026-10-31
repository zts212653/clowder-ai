import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertDeliveredLiveSource as delivered,
  createCanonicalLiveSourceFixture as fixture,
  assertPendingLiveSource as pending,
} from './helpers/1398-live-source-fixture.mjs';

// C7: body delivery attaches to the admitted exact response; it never creates
// a second read owner or completes business work. Old read-proof append-only
// assertions belonged to the retired Message-custody writer.
test('anchor and sparse queries do not acquire pending work; full delivery is exact and replay-safe', async (t) => {
  const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' });
  t.after(f.close);
  const headers = { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken };
  for (const query of ['', '?responseMode=full&keyword=body']) {
    const read = await f.app.inject({ method: 'GET', url: '/api/callbacks/thread-context' + query, headers });
    assert.equal(read.statusCode, 200, read.body);
    await pending(f);
  }
  const full = await f.read();
  assert.equal(full.statusCode, 200, full.body);
  assert.ok(full.json().messages.some((m) => m.id === f.message.id && m.content === f.message.content));
  await delivered(f);
  const first = structuredClone(f.store.getById(f.message.id).lifecycle.dispatchRefs);
  for (let i = 0; i < 3; i++) assert.equal((await f.read()).statusCode, 200);
  assert.deepEqual(f.store.getById(f.message.id).lifecycle.dispatchRefs, first);
  assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
  assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
});

for (const change of [
  { invocationId: 'other-child' },
  { userId: 'other-owner' },
  { threadId: 'other-thread' },
  { catId: 'kimi' },
])
  test('returned execution identity cannot authorize body delivery: ' + JSON.stringify(change), async (t) => {
    const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' });
    t.after(f.close);
    const original = f.turns.get.bind(f.turns);
    f.turns.get = (id) => {
      const turn = original(id);
      return turn ? { ...turn, ...change } : null;
    };
    const read = await f.read();
    assert.equal(read.statusCode, 409, read.body);
    await pending(f);
    assert.deepEqual(f.store.getById(f.response.id).lifecycle.inputMessageIds, []);
  });

test('an admitted full-body read drains through closing; later reads cannot acquire or settle any source', async (t) => {
  const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' });
  t.after(f.close);
  const commit = f.store.commitLifecycleAppendAdmission.bind(f.store);
  let entered, release;
  const started = new Promise((r) => {
    entered = r;
  });
  const barrier = new Promise((r) => {
    release = r;
  });
  f.store.commitLifecycleAppendAdmission = async (input) => {
    entered();
    await barrier;
    return commit(input);
  };
  const accepted = f.read().then((r) => r);
  await started;
  f.gate.close();
  let drained = false;
  const closing = f.gate.drain().then(() => {
    drained = true;
  });
  try {
    assert.equal((await f.read()).statusCode, 409);
    assert.equal(drained, false);
  } finally {
    release();
  }
  assert.equal((await accepted).statusCode, 200);
  await closing;
  await delivered(f);
  assert.equal((await f.read()).statusCode, 409);
  assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
});
