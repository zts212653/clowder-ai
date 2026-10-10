import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCanonicalLiveSourceFixture as fixture,
  assertPendingLiveSource as pending,
} from './helpers/1398-live-source-fixture.mjs';

test('missing exact execution truth grants neither delivery nor source completion', async (t) => {
  const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' });
  t.after(f.close);
  f.turns.get = () => null;
  const read = await f.read();
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(
    read.json().messages.some((m) => m.id === f.message.id),
    false,
  );
  await pending(f);
  assert.equal(f.store.getById(f.response.id).lifecycle.status, 'processing');
  assert.deepEqual(f.store.getById(f.response.id).lifecycle.inputMessageIds, []);
});

test('human and agent sources remain distinct ledger entries and attach to one exact response without business completion', async (t) => {
  const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' });
  t.after(f.close);
  const from = { kind: 'agent', catId: 'opus' };
  const second = await f.queue.send(
    f.store,
    {
      from,
      userId: 'owner',
      threadId: 'home',
      content: 'a distinct agent request',
      mentions: ['codex-astra', 'kimi'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    },
    {
      from,
      userId: 'owner',
      threadId: 'home',
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: 'a distinct agent request',
      targetCats: ['codex-astra', 'kimi'],
      intent: 'execute',
    },
  );
  assert.notEqual(second.entry.id, f.entry.id);
  assert.deepEqual(
    f.queue.list('home', 'owner').map((e) => e.payload.messageId),
    [f.message.id, second.message.id],
  );
  const full = await f.read();
  assert.equal(full.statusCode, 200, full.body);
  for (const source of [f.message, second.message]) {
    const input = f.store.getById(source.id);
    assert.equal(input.lifecycle.dispatchRefs.length, 1);
    assert.deepEqual(
      input.lifecycle.dispatchRefs.map((ref) => [ref.targetId, ref.statusMessageId, ref.phase]),
      [['codex-astra', f.response.id, 'dispatched']],
    );
    assert.equal(Object.hasOwn(input, 'queueCustody'), false);
  }
  assert.deepEqual(
    f.queue.list('home', 'owner').map((e) => e.targets),
    [['kimi'], ['kimi']],
  );
  const response = f.store.getById(f.response.id);
  assert.equal(response.lifecycle.status, 'processing');
  assert.deepEqual(new Set(response.lifecycle.inputMessageIds), new Set([f.message.id, second.message.id]));
  assert.equal(f.store.getByThread('home', 30, 'owner').filter((m) => m.lifecycle?.kind === 'response').length, 1);
});
