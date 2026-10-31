import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveExactDispatchFixture } from './helpers/live-exact-dispatch-fixture.mjs';

for (const order of ['first', 'second'])
  test(`Live targeted ${order} source leaves its sibling pending and replay is inert`, async (t) => {
    const f = await liveExactDispatchFixture();
    t.after(f.close);
    const sibling = await f.addSource('separate sibling body');
    const target = order === 'first' ? f.message : sibling;
    const other = order === 'first' ? sibling : f.message;
    const response = await f.readExact(target);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(
      response.json().messages.some((message) => message.id === target.id && message.content === target.content),
    );
    assert.equal(f.store.getById(target.id).lifecycle.dispatchRefs.length, 1);
    assert.equal(f.store.getById(target.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
    assert.equal(f.store.getById(other.id).lifecycle.dispatchRefs?.length ?? 0, 0);
    assert.deepEqual(
      f.queue.list('home', 'owner').map((entry) => entry.payload.messageId),
      [other.id],
    );
    const before = structuredClone(f.store.getById(target.id).lifecycle);
    assert.equal((await f.readExact(target)).statusCode, 200);
    assert.deepEqual(f.store.getById(target.id).lifecycle, before);
  });

test('a later producer gets a separate row while an exact Live admission commits', async (t) => {
  const f = await liveExactDispatchFixture();
  t.after(f.close);
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const commit = f.store.commitLifecycleAppendAdmission.bind(f.store);
  f.store.commitLifecycleAppendAdmission = async (input) => {
    entered();
    await barrier;
    return commit(input);
  };
  const read = f.readExact(f.message).then((result) => result);
  try {
    await started;
    const sibling = await f.addSource('concurrent independent producer');
    release();
    assert.equal((await read).statusCode, 200);
    assert.deepEqual(
      f.queue.list('home', 'owner').map((entry) => entry.payload.messageId),
      [sibling.id],
    );
    assert.equal(f.store.getById(sibling.id).lifecycle.dispatchRefs?.length ?? 0, 0);
  } finally {
    release();
    await read;
  }
});

test('failed Live admission restores the exact input and a retry cannot consume a later sibling', async (t) => {
  const f = await liveExactDispatchFixture();
  t.after(f.close);
  const commit = f.store.commitLifecycleAppendAdmission.bind(f.store);
  let reject = true;
  f.store.commitLifecycleAppendAdmission = (input) => {
    if (reject) {
      reject = false;
      throw new Error('synthetic admission failure');
    }
    return commit(input);
  };
  assert.equal((await f.readExact(f.message)).statusCode, 503);
  assert.equal(f.queue.list('home', 'owner').length, 1);
  const sibling = await f.addSource('arrived after failure');
  assert.equal((await f.readExact(f.message)).statusCode, 200);
  assert.deepEqual(
    f.queue.list('home', 'owner').map((entry) => entry.payload.messageId),
    [sibling.id],
  );
});
