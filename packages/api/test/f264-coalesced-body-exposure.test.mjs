import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalLiveSourceFixture as fixture } from './helpers/1398-live-source-fixture.mjs';

test('a source appended after delivery keeps its own pending entry until exact response admission', async (t) => {
  const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' }, 'agent');
  t.after(f.close);
  assert.equal((await f.read()).statusCode, 200);
  const from = { kind: 'agent', catId: 'opus' };
  const second = await f.queue.send(
    f.store,
    {
      userId: 'owner',
      threadId: 'home',
      from,
      content: 'second source',
      mentions: ['codex-astra'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    },
    {
      userId: 'owner',
      threadId: 'home',
      kind: 'conversation_input',
      from,
      content: 'second source',
      targetCats: ['codex-astra'],
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      authorIntentByCatId: { 'codex-astra': { requested: 'continue_current', boundParentInvocationId: 'live-parent' } },
    },
  );
  assert.ok(second.message && second.entry);
  assert.notEqual(second.entry.id, f.entry.id, 'distinct source bodies never coalesce into a single pending owner');
  assert.equal(f.store.getById(second.message.id).lifecycle.dispatchRefs.length, 0);
  assert.deepEqual((await f.queue.getDurableEntry('home', second.entry.id)).targets, ['codex-astra']);
  assert.equal((await f.read()).statusCode, 200);
  const first = f.store.getById(f.message.id),
    last = f.store.getById(second.message.id);
  assert.equal(first.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(last.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(await f.queue.getDurableEntry('home', second.entry.id), null);
  assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['kimi']);
  assert.equal((await f.read()).statusCode, 200);
  assert.equal(last.lifecycle.dispatchRefs.length, 1);
  assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
});
