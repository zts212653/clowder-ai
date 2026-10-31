import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScarceNotificationFixture } from './helpers/scarce-notification-fixture.js';

async function setupPrincipal(t, principal) {
  const fixture = await createScarceNotificationFixture();
  t.after(() => fixture.close());
  const auth = await fixture.setup({ queued: true });
  const { secret } = await fixture.agentKeys.issue('opus', 'user-1');
  const payload = {
    threadId: fixture.target.id,
    content: 'Retryable notification',
    targetCats: ['fable-5'],
    effectClass: 'fyi',
    clientMessageId: 'retry-notification',
  };
  const send = (overrides = {}) =>
    principal === 'invocation-token'
      ? fixture.post(auth, { ...payload, ...overrides })
      : fixture.app.inject({
          method: 'POST',
          url: '/api/callbacks/post-message',
          headers: { 'x-agent-key-secret': secret },
          payload: { ...payload, ...overrides },
        });
  return { fixture, send };
}

function assertReceipt(response) {
  assert.equal(response.statusCode, 200, response.body);
  const receipt = response.json();
  assert.ok(receipt.messageId, response.body);
  assert.deepEqual(receipt.deliveredWithoutWake, ['fable-5']);
  assert.match(receipt.message, /已送达，未叫醒/);
  return receipt;
}

function assertOneQuietDelivery(fixture) {
  assert.equal(fixture.messages.getByThread(fixture.target.id, 100, 'user-1').length, 1);
  assert.deepEqual(fixture.records, []);
  assert.deepEqual(fixture.executions, []);
  assert.equal(fixture.queue.list(fixture.target.id, 'user-1').length, 0);
}

for (const principal of ['invocation-token', 'agent-key']) {
  test(`${principal}: the injected queue stays quiet for FYI but admits actionable delivery`, async (t) => {
    const { fixture, send } = await setupPrincipal(t, principal);
    const enqueue = t.mock.method(fixture.queue, 'send');
    assertReceipt(await send());
    assertOneQuietDelivery(fixture);
    assert.equal(enqueue.mock.callCount(), 0, 'FYI must never touch the real injected queue');
    const active = await send({ targetCats: ['codex'], effectClass: 'coordinate', clientMessageId: 'active-control' });
    assert.equal(active.statusCode, 200, active.body);
    assert.equal(enqueue.mock.callCount(), 1, 'the route must actually be wired to this queue');
    const queued = fixture.queue.list(fixture.target.id, 'user-1');
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].targets, ['codex']);
  });

  test(`${principal}: append failure leaves the same notification key retryable`, async (t) => {
    const { fixture, send } = await setupPrincipal(t, principal);
    const append = fixture.messages.appendIdempotent.bind(fixture.messages);
    let failNextAppend = true;
    t.mock.method(fixture.messages, 'appendIdempotent', (input) => {
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error('one-shot durable append failure');
      }
      return append(input);
    });
    const failed = await send();
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(fixture.messages.getByThread(fixture.target.id, 100, 'user-1').length, 0);
    const recovered = assertReceipt(await send());
    assert.equal(recovered.status, 'ok');
    const replayed = assertReceipt(await send());
    assert.equal(replayed.status, 'duplicate');
    assert.equal(replayed.messageId, recovered.messageId);
    assertOneQuietDelivery(fixture);
  });

  test(`${principal}: concurrent same-key notifications converge on one durable receipt`, async (t) => {
    const { fixture, send } = await setupPrincipal(t, principal);
    const append = fixture.messages.appendIdempotent.bind(fixture.messages);
    t.mock.method(fixture.messages, 'appendIdempotent', async (input) => {
      // Yield before persistence so both requests can pass ingress together.
      await new Promise((resolve) => setImmediate(resolve));
      return append(input);
    });
    const responses = await Promise.all([send(), send()]);
    const receipts = responses.map(assertReceipt);
    assert.equal(receipts[0].messageId, receipts[1].messageId);
    assert.deepEqual(receipts.map((receipt) => receipt.status).sort(), ['duplicate', 'ok']);
    assertOneQuietDelivery(fixture);
  });
}
