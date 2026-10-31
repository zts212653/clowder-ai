import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleLifecycleResponseInputs } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ordinaryDispatchFixture } from './helpers/ordinary-dispatch-fixture.js';

for (const read of ['window', 'targeted-window', 'drill']) {
  test(
    'ordinary ' + read + ' delivers new input to the original response without a second completion protocol',
    async (t) => {
      const f = await ordinaryDispatchFixture(t);
      assert.equal((await f.read()).statusCode, 200);
      const source = await f.addSource('second request');
      const path =
        read === 'window'
          ? '/api/callbacks/thread-context?responseMode=full'
          : read === 'targeted-window'
            ? '/api/callbacks/thread-context?messageId=' + source.id + '&before=0&after=0&responseMode=full'
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

for (const shape of ['full', 'preview', 'oversized']) {
  test(`targeted ${shape} window changes only a fully returned exact input`, async (t) => {
    const f = await ordinaryDispatchFixture(t);
    assert.equal((await f.read()).statusCode, 200);
    const neighbor = await f.addSource('neighbor request');
    const target = await f.addSource(shape === 'oversized' ? 'x'.repeat(30000) : 'exact request');
    const response = await f.get(
      `/api/callbacks/thread-context?messageId=${target.id}&before=3&after=3${shape === 'preview' ? '' : '&responseMode=full'}`,
    );
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.a2aDispatchDisposition, undefined);
    assert.equal(f.store.getById(neighbor.id).lifecycle.dispatchRefs?.length ?? 0, 0);
    assert.equal(f.store.getById(target.id).lifecycle.dispatchRefs?.length ?? 0, shape === 'full' ? 1 : 0);
    const pendingIds = f.queue.list('home', 'owner').map((entry) => entry.payload.messageId);
    assert.ok(pendingIds.includes(neighbor.id));
    assert.equal(pendingIds.includes(target.id), shape !== 'full');
    const before = structuredClone(f.store.getById(target.id).lifecycle);
    assert.equal(
      (
        await f.get(
          `/api/callbacks/thread-context?messageId=${target.id}&before=0&after=0${shape === 'preview' ? '' : '&responseMode=full'}`,
        )
      ).statusCode,
      200,
    );
    assert.deepEqual(f.store.getById(target.id).lifecycle, before);
  });
}
