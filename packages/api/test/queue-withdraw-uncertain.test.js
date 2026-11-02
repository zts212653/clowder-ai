import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { isTimelinePublished } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';

async function queueApi(t, f) {
  const app = Fastify();
  await app.register(queueRoutes, {
    threadStore: { get: async (id) => (id === 'thread' ? { id, createdBy: 'owner' } : null) },
    invocationQueue: f.queue,
    queueProcessor: f.processor,
    invocationTracker: f.invocationTracker,
    messageStore: f.messageStore,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
  });
  t.after(() => app.close());
  return app;
}

const headers = { 'x-cat-cafe-user': 'owner' };

for (const action of ['single', 'clear']) {
  test(`${action} keeps already-published cat speech when its undelivered wake is withdrawn`, async (t) => {
    const f = await appendRecoveryFixture(
      async () => {
        assert.fail('withdrawal must not dispatch');
      },
      {
        from: { kind: 'agent', catId: 'codex' },
      },
    );
    const original = structuredClone(await f.messageStore.getById(f.admission.message.id));
    assert.equal(original.deliveryStatus, 'queued');
    assert.equal(isTimelinePublished(original), true);
    const app = await queueApi(t, f);
    const url = `/api/threads/thread/queue${action === 'single' ? `/${f.admission.entry.id}` : ''}`;
    const result = await app.inject({ method: 'DELETE', url, headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
    assert.deepEqual(await f.messageStore.getById(original.id), original);
    assert.ok(
      f.messageStore
        .getByThread('thread', 100, 'owner', { includeQueuedCatMessages: true })
        .some((m) => m.id === original.id),
    );
  });
}

for (const from of [
  { kind: 'user', userId: 'owner' },
  { kind: 'agent', catId: 'codex' },
]) {
  for (const action of ['single', 'clear']) {
    test(`${action} stops an uncertain ${from.kind} input without retracting its published history or resending`, async (t) => {
      let inputRead;
      const dispatch = mock.fn(async (input) => {
        inputRead = input.onInputRead;
        return { accepted: false, reason: 'provider_rejected', acceptance: 'unknown' };
      });
      const f = await appendRecoveryFixture(dispatch, { from });
      await f.append();
      await f.processor.reconcileAppendDeliveries('thread');
      const original = structuredClone(await f.messageStore.getById(f.admission.message.id));
      const reply = structuredClone(await f.messageStore.getById(f.response.id));
      assert.equal(original.lifecycle.appendFailures[0].acceptance, 'unknown');
      assert.ok(original.lifecycle.appendFailures[0].checkedAt);
      assert.equal(isTimelinePublished(original), true);
      const app = await queueApi(t, f);
      const url = `/api/threads/thread/queue${action === 'single' ? `/${f.admission.entry.id}` : ''}`;
      const stopped = await app.inject({ method: 'DELETE', url, headers });
      assert.equal(stopped.statusCode, 200, stopped.body);
      assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
      assert.deepEqual((await f.messageStore.getById(original.id)).lifecycle, original.lifecycle);
      assert.deepEqual((await f.messageStore.getById(reply.id)).lifecycle, reply.lifecycle);
      assert.equal(isTimelinePublished(await f.messageStore.getById(original.id)), true);
      assert.equal((await f.messageStore.getById(original.id)).content, original.content);
      // Stopping future work must not erase a late receipt from the original attempt.
      await inputRead();
      assert.equal((await f.messageStore.getById(original.id)).lifecycle.dispatchRefs[0].inputRead.status, 'read');
      await f.processor.requestDrain('thread');
      assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
      assert.equal(dispatch.mock.callCount(), 1);
      assert.deepEqual(
        (await app.inject({ method: 'GET', url: '/api/threads/thread/queue', headers })).json().queue,
        [],
      );
    });
  }
}

test('Clear reports the retained in-flight input, and partial success does not claim an empty queue', async (t) => {
  let release;
  let reached;
  const handoff = new Promise((resolve) => {
    reached = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await appendRecoveryFixture(async () => {
    reached();
    await pending;
    return { accepted: false, reason: 'exception', acceptance: 'unknown' };
  });
  const app = await queueApi(t, f);
  const append = f.append();
  await handoff;
  t.after(async () => {
    release();
    await append;
  });
  const original = structuredClone(await f.messageStore.getById(f.admission.message.id));
  const url = '/api/threads/thread/queue';
  const refused = await app.inject({ method: 'DELETE', url, headers });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().code, 'QUEUE_WITHDRAWAL_FAILED');
  assert.deepEqual(refused.json().cleared, []);
  assert.deepEqual(
    refused.json().queue.map((entry) => entry.id),
    [f.admission.entry.id],
  );
  assert.deepEqual((await f.messageStore.getById(original.id)).lifecycle, original.lifecycle);

  const ordinary = await f.queue.enqueueDurable({
    threadId: 'thread',
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    sourceId: 'later-input',
    content: 'later work',
    targetCats: ['opus'],
    intent: 'execute',
  });
  const partial = await app.inject({ method: 'DELETE', url, headers });
  assert.equal(partial.statusCode, 409, partial.body);
  assert.equal(partial.json().code, 'QUEUE_WITHDRAWAL_PARTIAL');
  assert.deepEqual(
    partial.json().cleared.map((entry) => entry.id),
    [ordinary.entry.id],
  );
  assert.deepEqual(
    partial.json().queue.map((entry) => entry.id),
    [f.admission.entry.id],
  );
});

test('a completed uncertain handoff still cannot be recalled into the composer as if it was never exposed', async () => {
  const f = await appendRecoveryFixture(async () => ({ accepted: false, reason: 'exception', acceptance: 'unknown' }));
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  assert.equal(
    (await f.queue.claimMessageEntriesForWithdrawal('thread', 'owner', f.admission.message.id)).outcome,
    'processing',
  );
});
