import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { firstMessageHarness, waitFor } from './helpers/f247-first-message-harness.js';

let h;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

test('concurrent replay cannot start the cloud carrier before its source append commits', async () => {
  let release;
  let appending = false;
  const fence = new Promise((resolve) => {
    release = resolve;
  });
  h = await firstMessageHarness({
    bound: true,
    beforeAppend: async (message) => {
      if (message.userId === 'first-message-owner' && message.catId === null) {
        appending = true;
        await fence;
      }
    },
  });
  const request = { idempotencyKey: 'ce744f53-5f51-418a-b2c3-7301e7984f83' };
  const original = h.send(request).then((response) => response);
  await waitFor(() => appending);
  try {
    const replay = await h.send(request);
    assert.equal(replay.statusCode, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.hostCalls.length, 0);
    assert.equal(h.routeCalls.length, 0, 'no provider route before the original source exists');
    assert.equal(h.queue.list(h.thread.id, h.userId)[0].status, 'queued');
  } finally {
    release();
  }
  const sourceId = (await original).json().userMessageId;
  await waitFor(() => h.hostCalls.length === 1);
  await h.settle();
  assert.equal(h.hostCalls[0].idempotencyKey, sourceId);
  assert.equal(h.routeCalls.length, 1);
});

test('failed source persistence leaves no executable cloud carrier or provider request', async () => {
  h = await firstMessageHarness({
    bound: true,
    beforeAppend: (message) => {
      if (message.userId === 'first-message-owner') throw new Error('source storage unavailable');
    },
  });
  assert.equal((await h.send()).statusCode, 500);
  assert.equal(h.queue.list(h.thread.id, h.userId).length, 0);
  assert.equal(h.routeCalls.length, 0);
  assert.equal(h.hostCalls.length, 0);
});

for (const deliveryMode of ['immediate', 'queue']) {
  test(`explicit ${deliveryMode} on an idle thread retains first-source recovery`, async () => {
    h = await firstMessageHarness();
    const response = await h.send({ deliveryMode });
    assert.equal(response.statusCode, 202, response.body);
    await h.settle();
    assert.equal((await h.authority(response.json().userMessageId)).statusCode, 200);
    assert.equal(h.hostCalls.length, 0);
  });
}

test('mixed local/cloud admission retries only the failed cloud target', async () => {
  h = await firstMessageHarness({ targetCats: ['opus', 'gpt-pro'] });
  const sourceId = (await h.send()).json().userMessageId;
  await h.settle();
  const authority = await h.authority(sourceId);
  assert.equal(
    authority.statusCode,
    200,
    JSON.stringify({ authority: authority.json(), logs: h.logs }, (_key, value) =>
      value instanceof Error ? value.stack : value,
    ),
  );
  const attemptId = authority.json().attemptId;
  const before = h.routeCalls.flatMap((call) => call.targets);
  assert.equal(before.filter((catId) => catId === 'opus').length, 1);
  assert.equal(before.filter((catId) => catId === 'gpt-pro').length, 1);
  await h.bind();
  assert.equal((await h.retry(sourceId, attemptId)).statusCode, 202);
  await waitFor(() => h.hostCalls.length === 1);
  await h.settle();
  const after = h.routeCalls.flatMap((call) => call.targets);
  assert.equal(after.filter((catId) => catId === 'opus').length, 1);
  assert.equal(after.filter((catId) => catId === 'gpt-pro').length, 2);
  assert.equal(h.hostCalls[0].idempotencyKey, sourceId);
});

test('ordinary local immediate dispatch retains its existing source and execution', async () => {
  h = await firstMessageHarness({ targetCats: ['opus'] });
  const response = await h.send();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'processing');
  await h.settle();
  assert.equal(h.messageStore.getById(response.json().userMessageId).queueCustody, undefined);
  assert.equal(h.routeCalls.length, 1);
  assert.equal(h.hostCalls.length, 0);
});

test('explicit force still preempts the owned cloud slot using its existing direct path', async () => {
  h = await firstMessageHarness({ bound: true });
  const previous = h.tracker.start(h.thread.id, 'gpt-pro', h.userId, ['gpt-pro']);
  const response = await h.send({ deliveryMode: 'force' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'processing');
  assert.equal(previous.signal.aborted, true);
  await waitFor(() => h.hostCalls.length === 1);
  await h.settle();
  assert.equal(h.messageStore.getById(response.json().userMessageId).queueCustody, undefined);
  assert.equal(h.hostCalls[0].idempotencyKey, response.json().userMessageId);
});

test('a busy cloud slot queues the source and obtains recovery after the existing owner completes', async () => {
  h = await firstMessageHarness();
  const previous = h.tracker.start(h.thread.id, 'gpt-pro', h.userId, ['gpt-pro']);
  const sourceId = (await h.send()).json().userMessageId;
  assert.equal(h.routeCalls.length, 0);
  assert.equal(previous.signal.aborted, false);
  assert.ok(h.messageStore.getById(sourceId).queueCustody);
  h.tracker.complete(h.thread.id, 'gpt-pro', previous);
  await h.processor.onInvocationComplete(h.thread.id, 'gpt-pro', 'succeeded', undefined, ['gpt-pro']);
  await h.settle();
  assert.equal((await h.authority(sourceId)).statusCode, 200);
  assert.equal(h.routeCalls.length, 1);
});
