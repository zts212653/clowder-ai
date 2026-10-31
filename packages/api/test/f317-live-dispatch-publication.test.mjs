import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichQueueEntries } from '../src/utils/queue-enrichment.ts';
import { createCanonicalLiveSourceFixture as fixture } from './helpers/1398-live-source-fixture.mjs';

const intent = { requested: 'continue_current', boundParentInvocationId: 'live-parent' };
for (const targetCats of [['codex-astra'], ['codex-astra', 'kimi']]) {
  test(
    'full Live delivery publishes committed pending targets; F5 joins the same authority: ' + targetCats,
    async (t) => {
      const events = [];
      const f = await fixture(intent, 'agent', {
        targetCats,
        socketManager: {
          emitToUser(owner, event, payload) {
            events.push({ owner, event, payload });
          },
          broadcastToRoom() {},
          broadcastAgentMessage() {},
        },
      });
      t.after(f.close);
      assert.equal((await f.read()).statusCode, 200);
      const update = events.filter((e) => e.event === 'queue_updated').at(-1);
      assert.ok(update);
      assert.equal(update.owner, 'owner');
      assert.equal(update.payload.threadId, 'home');
      assert.deepEqual(
        update.payload.queue.map((e) => e.targetCats),
        targetCats.length === 1 ? [] : [['kimi']],
      );
      const hydrated = await enrichQueueEntries(f.queue.list('home', 'owner'), f.store);
      assert.deepEqual(
        hydrated.map((e) => ({ id: e.id, targets: e.targetCats })),
        update.payload.queue.map((e) => ({ id: e.id, targets: e.targetCats })),
      );
      const refs = structuredClone(f.store.getById(f.message.id).lifecycle.dispatchRefs);
      assert.equal(refs.length, 1);
      assert.equal(refs[0].statusMessageId, f.response.id);
      assert.equal(refs[0].phase, 'dispatched');
      for (let i = 0; i < 2; i++) assert.equal((await f.read()).statusCode, 200);
      assert.deepEqual(f.store.getById(f.message.id).lifecycle.dispatchRefs, refs);
      assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
      assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.from.kind === 'system').length, 0);
    },
  );
}

test('a lost socket publication cannot undo delivered History or re-dispatch on full-read replay', async (t) => {
  let fail = true;
  const f = await fixture(intent, 'agent', {
    socketManager: {
      emitToUser(_owner, event) {
        if (event === 'queue_updated' && fail) {
          fail = false;
          throw new Error('fixture socket unavailable');
        }
      },
      broadcastToRoom() {},
      broadcastAgentMessage() {},
    },
  });
  t.after(f.close);
  const first = await f.read();
  assert.notEqual(first.statusCode, 200, first.body);
  const before = structuredClone(f.store.getById(f.message.id).lifecycle.dispatchRefs);
  assert.equal(before.length, 1, 'committed delivery survives a lost live projection');
  assert.equal(before[0].statusMessageId, f.response.id);
  assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['kimi']);
  assert.equal((await f.read()).statusCode, 200);
  assert.deepEqual(f.store.getById(f.message.id).lifecycle.dispatchRefs, before);
  const f5 = await enrichQueueEntries(f.queue.list('home', 'owner'), f.store);
  assert.deepEqual(
    f5.map((e) => e.targetCats),
    [['kimi']],
  );
  assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
});
