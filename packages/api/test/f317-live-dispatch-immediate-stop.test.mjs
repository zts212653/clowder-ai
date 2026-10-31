import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.ts';
import {
  assertDeliveredLiveSource as delivered,
  createCanonicalLiveSourceFixture as fixture,
  assertPendingLiveSource as pending,
} from './helpers/1398-live-source-fixture.mjs';

const intent = { requested: 'continue_current', boundParentInvocationId: 'live-parent' };
for (const termination of ['stop', 'fail']) {
  test('an authenticated, admitted body delivery drains through immediate native ' + termination, async (t) => {
    const sessions = new LiveCompanionSessions();
    const f = await fixture(intent, 'agent', {
      withLiveCarrierOperation: sessions.withCarrierOperation.bind(sessions),
    });
    t.after(async () => {
      await sessions.close();
      await f.close();
    });
    const call = await sessions.prepare({
      binding: { userId: 'owner', threadId: 'home', catId: 'codex-astra', callId: 'call' },
      messageStore: f.store,
      mcpDistDir: resolve('../mcp-server/dist'),
      allowedDirectories: [resolve('../../docs')],
      verifyNativeBinding: async () => true,
      publish() {},
    });
    await sessions.claim(call.id, 'owner', 'home', ['codex-astra']);
    await call.configure({
      CAT_CAFE_API_URL: 'http://localhost:3012',
      CAT_CAFE_USER_ID: 'owner',
      CAT_CAFE_THREAD_ID: 'home',
      CAT_CAFE_CAT_ID: 'codex-astra',
      CAT_CAFE_INVOCATION_ID: f.auth.invocationId,
      CAT_CAFE_CALLBACK_TOKEN: f.auth.callbackToken,
    });
    await call.ready('native', { request: async () => ({}), submitText: async () => 'unused' });
    const commit = f.store.commitLifecycleAppendAdmission.bind(f.store);
    let enter, release;
    const entered = new Promise((r) => {
      enter = r;
    });
    const barrier = new Promise((r) => {
      release = r;
    });
    f.store.commitLifecycleAppendAdmission = async (input) => {
      enter();
      await barrier;
      return commit(input);
    };
    const accepted = f.read().then((r) => r);
    await entered;
    let drained = false;
    const stopped = (termination === 'stop' ? call.stop() : call.fail(new Error('fixture failure'))).then(() => {
      drained = true;
    });
    try {
      assert.equal((await f.read()).statusCode, 409);
      assert.equal(drained, false, 'native terminal waits for the accepted durable admission');
    } finally {
      release();
    }
    assert.equal((await accepted).statusCode, 200);
    await stopped;
    await delivered(f);
    assert.equal((await f.read()).statusCode, 409);
    assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
    assert.equal(
      f.store.getById(f.response.id).lifecycle.status,
      'processing',
      'source delivery does not itself terminalize the independent native execution',
    );
  });
}

test('a request that has not authenticated before the closing fence acquires no pending source', async (t) => {
  const f = await fixture(intent);
  t.after(f.close);
  f.gate.close();
  const scheduled = f.read();
  assert.equal((await scheduled).statusCode, 409);
  await pending(f);
  assert.deepEqual(f.store.getById(f.response.id).lifecycle.inputMessageIds, []);
});

test('invalid callback credentials cannot borrow the live lease or mutate source ownership', async (t) => {
  const f = await fixture(intent);
  t.after(f.close);
  const denied = await f.app.inject({
    method: 'GET',
    url: '/api/callbacks/thread-context?responseMode=full',
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': 'wrong' },
  });
  assert.equal(denied.statusCode, 401);
  await pending(f);
  assert.deepEqual(f.store.getById(f.response.id).lifecycle.inputMessageIds, []);
});
