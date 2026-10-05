import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callbackCustodyFixture, DELEGATE, NEXT_CAT } from './f290-communication-a2a-custody-callback.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

test('validated first callback hop remains admitted to its original private Work', async () => {
  const f = await callbackCustodyFixture();
  try {
    const before = await f.tasks.get(f.task.id);
    const first = await f.firstHop();
    assert.equal(first.current.work.task.id, f.task.id);
    assert.deepEqual(first.source.extra?.collectiveWorkDelegationV1?.targetCatIds, [DELEGATE]);
    const carrier = f.queue
      .list(f.task.threadId, f.cafe.ownerUserId)
      .find((entry) => entry.targetCats.includes(DELEGATE));
    assert.ok(carrier);
    assert.equal(carrier.a2aTriggerMessageId, first.source.id);
    assert.equal((await f.messages.getById(first.source.id))?.queueCustody?.pendingTargetCats.includes(DELEGATE), true);
    assert.deepEqual(
      await f.tasks.get(f.task.id),
      before,
      'Relay does not transfer accountability or mutate Task birth',
    );
  } finally {
    await f.close();
  }
});

for (const addressing of ['explicit-target', 'line-start-mention'] as const) {
  test(`a private delegate's second callback hop fails closed before ${addressing} can mint ordinary home custody`, async () => {
    const f = await callbackCustodyFixture();
    try {
      const first = await f.firstHop();
      const payload =
        addressing === 'explicit-target'
          ? { content: 'Please continue this same Work', targetCats: [NEXT_CAT] }
          : { content: `@${NEXT_CAT}\nPlease continue this same Work` };
      const second = await f.post(first.credentials, payload);
      const escaped = f.queue
        .list(f.task.threadId, f.cafe.ownerUserId)
        .find((entry) => entry.targetCats.includes(NEXT_CAT));
      assert.equal(
        second.statusCode,
        403,
        `Second post must be refused; actual ${second.statusCode}, C scope=${escaped?.executionScope ?? 'home'}`,
      );
      assert.equal(escaped, undefined, 'Refused C must have neither an ordinary nor a private Queue carrier');
      const posted = second.json().messageId;
      assert.equal(posted, undefined, 'Refusal must happen before publishing a runnable delegated source');
    } finally {
      await f.close();
    }
  });
}

test('a private delegate may post non-routing progress without creating another carrier', async () => {
  const f = await callbackCustodyFixture();
  try {
    const first = await f.firstHop();
    const before = f.queue.list(f.task.threadId, f.cafe.ownerUserId);
    const posted = await f.post(first.credentials, { content: 'Private progress on the existing Work, no handoff' });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.deepEqual(f.queue.list(f.task.threadId, f.cafe.ownerUserId), before);
  } finally {
    await f.close();
  }
});

test('ordinary home callback addressing still creates ordinary A2A custody', async () => {
  const f = await callbackCustodyFixture();
  const home = f.threads.create(f.cafe.ownerUserId, 'Ordinary home conversation');
  f.tracker.startAll(home.id, [NEXT_CAT], f.cafe.ownerUserId, 'fixture-ordinary-busy');
  try {
    const credentials = await f.registry.create(f.cafe.ownerUserId, CAT, home.id);
    const posted = await f.post(credentials, { content: 'Ordinary home handoff', targetCats: [NEXT_CAT] });
    assert.equal(posted.statusCode, 200, posted.body);
    const carrier = f.queue.list(home.id, f.cafe.ownerUserId)[0];
    assert.ok(carrier);
    assert.equal(carrier.executionScope, undefined);
    assert.ok(carrier.messageId);
    assert.equal(
      (await f.messages.getById(carrier.messageId))?.queueCustody?.pendingTargetCats.includes(NEXT_CAT),
      true,
    );
  } finally {
    f.tracker.cancelAll(home.id);
    await f.close();
  }
});
