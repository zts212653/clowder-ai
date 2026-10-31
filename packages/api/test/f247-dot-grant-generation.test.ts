import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCloudReturnGrantStore } from '../src/domains/cats/services/cloud-bridge/cloud-return-grant.js';

test('a pending dot retry acquires its own generation while Pro retains its existing grant', async () => {
  for (const targetCatId of ['gpt-dot', 'gpt-pro']) {
    const store = new MemoryCloudReturnGrantStore();
    const input = { threadId: 'thread', userId: 'owner', sourceMessageId: 'source', targetCatId };
    await store.issue({ ...input, dispatchInvocationId: 'first' });
    await store.issue({ ...input, dispatchInvocationId: 'retry' });
    const claim = await store.claim(input);
    assert.ok(claim.ok);
    assert.equal(claim.dispatchInvocationId, targetCatId === 'gpt-dot' ? 'retry' : 'first');
    assert.equal(await store.commit(claim), true);
    await store.issue({ ...input, dispatchInvocationId: 'after-completion' });
    assert.deepEqual(await store.claim(input), { ok: false, reason: 'consumed' });
  }
});

test('a dot retry cannot replace a return while its append claim is active', async () => {
  let now = Date.now();
  const store = new MemoryCloudReturnGrantStore(() => now);
  const input = { threadId: 'thread', userId: 'owner', sourceMessageId: 'source', targetCatId: 'gpt-dot' };
  await store.issue({ ...input, dispatchInvocationId: 'first' });
  const old = await store.claim(input);
  assert.ok(old.ok);
  assert.deepEqual(await store.issue({ ...input, dispatchInvocationId: 'retry' }), { ok: false, reason: 'in_flight' });
  now += 120_001;
  assert.equal((await store.issue({ ...input, dispatchInvocationId: 'retry' })).ok, true);
  assert.equal(await store.commit(old), false, 'expired older append cannot consume the refreshed grant');
  const next = await store.claim(input);
  assert.ok(next.ok);
  assert.equal(next.dispatchInvocationId, 'retry');
  assert.equal(await store.commit(old), false);
});
