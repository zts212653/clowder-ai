import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { firstMessageHarness, waitFor } from './helpers/f247-first-message-harness.js';

let h;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

test('idle first cloud message obtains a current retry fence and binds/retries the original source', async () => {
  h = await firstMessageHarness();
  const posted = await h.send();
  assert.ok([200, 202].includes(posted.statusCode), posted.body);
  const sourceId = posted.json().userMessageId;
  await h.settle();
  assert.equal(h.hostCalls.length, 0, 'unbound first attempt does not append to Host');
  const authority = await h.authority(sourceId);
  assert.equal(authority.statusCode, 200, `first-message recovery must exist: ${authority.body}`);
  const attemptId = authority.json().attemptId;
  const source = h.messageStore.getById(sourceId);
  assert.equal(source.queueCustody.targetAttempts.at(-1).state, 'failed');
  assert.equal(h.queue.hasOrdinaryEligibleQueuedForThread(h.thread.id), false);
  await h.processor.processNext(h.thread.id, h.userId);
  assert.equal(h.routeCalls.length, 1, 'ordinary progress never retries the failed target');
  assert.equal((await h.bind()).statusCode, 200);
  assert.equal(h.hostCalls.length, 0, 'binding alone is not a send');
  const retries = await Promise.all([h.retry(sourceId, attemptId), h.retry(sourceId, attemptId)]);
  assert.deepEqual(retries.map((response) => response.statusCode).sort(), [202, 409]);
  await waitFor(() => h.hostCalls.length === 1);
  await h.settle();
  assert.equal(h.hostCalls[0].idempotencyKey, sourceId);
  assert.deepEqual(
    h.routeCalls.map((call) => call.messageId),
    [sourceId, sourceId],
  );
  const history = await h.request('GET', `/api/messages?threadId=${h.thread.id}`);
  assert.equal(history.json().messages.filter((message) => message.type === 'user').length, 1);
  assert.ok(
    history.json().messages.some((message) => message.source?.meta?.cloudBridgeOutboundReceipt?.status === 'sent'),
  );
  assert.equal((await h.retry(sourceId, attemptId)).statusCode, 409);
  assert.equal(h.hostCalls.length, 1);
});

test('failed first source survives Queue reconstruction without automatic replay', async () => {
  h = await firstMessageHarness();
  const sourceId = (await h.send()).json().userMessageId;
  await h.settle();
  const before = await h.authority(sourceId);
  assert.equal(before.statusCode, 200, before.body);
  const recovered = await h.restart();
  assert.equal(recovered.messagesFailed, 0);
  assert.equal(recovered.entriesRestored, 1);
  assert.equal(h.queue.hasOrdinaryEligibleQueuedForThread(h.thread.id), false);
  await h.processor.processNext(h.thread.id, h.userId);
  assert.equal(h.routeCalls.length, 1);
  const after = await h.authority(sourceId);
  assert.deepEqual(after.json(), before.json());
  assert.equal((await h.authority(sourceId, 'other-owner')).statusCode, 404);
  assert.equal((await h.retry(sourceId, after.json().attemptId, 'other-owner')).statusCode, 404);
  await h.bind();
  assert.equal((await h.retry(sourceId, after.json().attemptId)).statusCode, 202);
  await waitFor(() => h.hostCalls.length === 1);
  await h.settle();
  assert.equal(h.hostCalls[0].idempotencyKey, sourceId);
});

test('an already bound first source sends once and repeated admission does not resurrect it', async () => {
  h = await firstMessageHarness({ bound: true });
  const request = { idempotencyKey: 'bca53f76-c72b-4d46-90c6-dbe329aa82b4' };
  const sourceId = (await h.send(request)).json().userMessageId;
  await waitFor(() => h.hostCalls.length === 1);
  await h.settle();
  const replay = await h.send(request);
  assert.equal(replay.json().userMessageId, sourceId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.hostCalls.length, 1);
  assert.equal(h.routeCalls.length, 1);
  assert.equal(h.queue.list(h.thread.id, h.userId).length, 0);
});
