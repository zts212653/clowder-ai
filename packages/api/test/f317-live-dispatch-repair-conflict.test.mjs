import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanonicalLiveSourceFixture as fixture } from './helpers/1398-live-source-fixture.mjs';

const intent = { requested: 'continue_current', boundParentInvocationId: 'live-parent' };
// Old event-first repair had two terminal owners. The same conflict protection
// now belongs to immutable response identity, source dispatchRef and terminal CAS.
for (const patch of [
  { invocationId: 'other-child' },
  { targetId: 'kimi' },
  { responseMessageId: 'missing-response' },
]) {
  test('a later timestamp cannot redirect committed Live input to ' + JSON.stringify(patch), async (t) => {
    const f = await fixture(intent, 'agent');
    t.after(f.close);
    assert.equal((await f.read()).statusCode, 200);
    const before = [structuredClone(f.store.getById(f.message.id)), structuredClone(f.store.getById(f.response.id))];
    const result = await f.store.commitLifecycleAppendAdmission({
      threadId: 'home',
      entryId: f.entry.id,
      inputMessageIds: [f.message.id],
      runs: [
        {
          targetId: 'codex-astra',
          invocationId: f.auth.invocationId,
          responseMessageId: f.response.id,
          dispatchedAt: Date.now() + 1000,
          ...patch,
        },
      ],
    });
    assert.ok(result.kind === 'conflict' || result.kind === 'not_found', JSON.stringify(result));
    assert.deepEqual([f.store.getById(f.message.id), f.store.getById(f.response.id)], before);
    assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['kimi']);
  });
}

for (const patch of [{ invocationId: 'other-child' }, { status: 'failed' }, { status: 'interrupted' }]) {
  test('terminal recovery cannot replace the original result with ' + JSON.stringify(patch), async (t) => {
    const f = await fixture(intent, 'agent');
    t.after(f.close);
    assert.equal((await f.read()).statusCode, 200);
    const terminal = {
      invocationId: f.auth.invocationId,
      status: 'completed',
      completedAt: Date.now(),
      content: 'original result',
      extra: f.response.extra,
      mentions: [],
      origin: 'stream',
    };
    assert.equal((await f.store.commitLifecycleResponseTerminal(f.response.id, terminal)).kind, 'applied');
    const before = structuredClone(f.store.getById(f.response.id));
    assert.equal(
      (
        await f.store.commitLifecycleResponseTerminal(f.response.id, {
          ...terminal,
          ...patch,
          completedAt: Date.now() + 1000,
          content: 'competing result',
        })
      ).kind,
      'conflict',
    );
    assert.deepEqual(f.store.getById(f.response.id), before);
    assert.equal(f.store.getById(f.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  });
}
