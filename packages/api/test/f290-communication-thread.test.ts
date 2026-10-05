import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';

test('an admitted source has one owned execution Thread across retries, distinct from another Work', async () => {
  const store = new ThreadStore();
  const seed = {
    userId: 'owner',
    idempotencyKey: 'collective:source-A:codex',
    title: 'Guide A',
    participants: ['codex'],
  };
  const a = await store.ensureOwnedThread(seed);
  const replay = await store.ensureOwnedThread(seed);
  const b = await store.ensureOwnedThread({ ...seed, idempotencyKey: 'collective:source-B:codex', title: 'Guide B' });
  assert.equal(a.id, replay.id);
  assert.notEqual(a.id, b.id);
  assert.equal(a.createdBy, 'owner');
  assert.deepEqual(a.participants, ['codex']);
  assert.equal((await store.list('owner')).length, 2);
  await store.updateTitle(a.id, 'Owner renamed A');
  assert.equal((await store.ensureOwnedThread(seed)).title, 'Owner renamed A');
  const otherOwner = await store.ensureOwnedThread({ ...seed, userId: 'other-owner' });
  assert.notEqual(otherOwner.id, a.id);
  assert.equal(await store.softDelete(b.id), true);
  await assert.rejects(async () => store.ensureOwnedThread({ ...seed, idempotencyKey: 'collective:source-B:codex' }), {
    code: 'OWNER_ADMISSION_UNAVAILABLE',
  });
  assert.equal(await store.delete(a.id), true);
  await assert.rejects(async () => store.ensureOwnedThread(seed), { code: 'OWNER_ADMISSION_UNAVAILABLE' });
});
