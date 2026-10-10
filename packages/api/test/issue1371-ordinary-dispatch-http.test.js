import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleLifecycleResponseInputs } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ordinaryDispatchFixture } from './helpers/ordinary-dispatch-fixture.js';

for (const read of ['window', 'drill']) {
  test(
    'ordinary ' + read + ' delivers new input to the original response without a second completion protocol',
    async (t) => {
      const f = await ordinaryDispatchFixture(t);
      assert.equal((await f.read()).statusCode, 200);
      const source = await f.addSource('second request');
      const path =
        read === 'window'
          ? '/api/callbacks/thread-context?responseMode=full'
          : '/api/callbacks/get-message?messageId=' + source.id + '&mode=full';
      const body = await f.get(path);
      assert.equal(body.statusCode, 200, body.body);
      assert.match(body.body, /second request/);
      for (const id of [f.message.id, source.id]) {
        const input = f.store.getById(id);
        assert.equal(input.lifecycle.dispatchRefs.length, 1);
        assert.equal(input.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
        assert.equal(input.queueCustody, undefined);
      }
      assert.deepEqual(f.queue.list('home', 'owner'), []);
      assert.equal((await f.get(path)).statusCode, 200);
      const terminal = f.store.commitLifecycleResponseTerminal(f.response.id, {
        invocationId: f.auth.invocationId,
        status: 'failed',
        completedAt: Date.now(),
        reason: 'fixture_provider_failure',
        content: '',
        mentions: [],
        origin: 'stream',
      });
      assert.equal(terminal.kind, 'applied');
      await settleLifecycleResponseInputs(f.store, terminal.message, f.response.id);
      assert.equal(f.store.getById(source.id).lifecycle.dispatchRefs[0].phase, 'settled');
      assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
      assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.from.kind === 'system').length, 0);
    },
  );
}
