import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { isOwnerRepeatableAppendTarget } from '../dist/domains/cats/services/agents/invocation/queue-routing-recovery-policy.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';

const denied = [
  { name: 'external', from: { kind: 'external', connectorId: 'collective' } },
  {
    name: 'scoped external',
    from: { kind: 'external', connectorId: 'collective' },
    executionScope: 'collective-participation',
  },
  { name: 'system', from: { kind: 'system', service: 'scheduler' } },
  { name: 'scoped system', from: { kind: 'system', service: 'collective-work' }, executionScope: 'collective-work' },
  { name: 'plugin', from: { kind: 'external', connectorId: 'github' } },
  { name: 'ordinary A2A', from: { kind: 'agent', catId: 'codex' } },
];
for (const example of denied) {
  test(`History repeat cannot promote ${example.name} into owner authority through real HTTP`, async (t) => {
    const f = await appendRecoveryFixture(
      async () => ({ accepted: false, reason: 'exception', acceptance: 'unknown' }),
      { ...example, ownerAuthProvenance: 'unknown' },
    );
    const app = Fastify();
    t.after(() => app.close());
    await app.register(queueRoutes, {
      threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner' }) },
      invocationQueue: f.queue,
      queueProcessor: f.processor,
      invocationTracker: f.invocationTracker,
      messageStore: f.messageStore,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { 'x-cat-cafe-user': 'owner', 'content-type': 'application/json' };
    const append = await fetch(`${origin}/api/threads/thread/queue/${f.admission.entry.id}/append`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedQueueRevision: f.queue.snapshotRevision('thread', 'owner'),
        expectedRuns: [{ targetId: 'opus', invocationId: 'turn', responseMessageId: f.response.id }],
      }),
    });
    assert.equal(append.status, 202, await append.text());
    await f.processor.reconcileAppendDeliveries('thread');
    const source = await f.messageStore.getById(f.admission.message.id);
    const before = await f.messageStore.getByThread('thread', 100, 'owner', { includeQueuedUserMessages: true });
    const path = `${origin}/api/threads/thread/messages/${source.id}/routing-targets/opus`;
    const snapshot = await (await fetch(path, { headers })).json();
    const repeated = await fetch(path + '/repeat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedResponseMessageId: f.response.id, expectedInvocationId: 'turn' }),
    });
    assert.deepEqual(
      {
        policy: isOwnerRepeatableAppendTarget(source, 'opus', f.response),
        projected: snapshot.canRepeat,
        status: repeated.status,
      },
      { policy: false, projected: false, status: 409 },
    );
    assert.equal(
      (await f.messageStore.getByThread('thread', 100, 'owner', { includeQueuedUserMessages: true })).length,
      before.length,
    );
    assert.deepEqual(f.queue.list('thread', 'owner'), []);
  });
}

test('an original human repeat preserves the existing reply target and keeps source receipts unchanged', async () => {
  const { repeatUncertainAppend } = await import(
    '../dist/domains/cats/services/agents/invocation/repeat-uncertain-append.js'
  );
  const f = await appendRecoveryFixture(async () => ({ accepted: false, reason: 'exception', acceptance: 'unknown' }), {
    replyTo: 'original-reply-target',
  });
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  const source = await f.messageStore.getById(f.admission.message.id);
  const retried = await repeatUncertainAppend(f.queue, f.messageStore, source, 'opus');
  assert.ok(retried);
  assert.notEqual(retried.message.id, source.id);
  assert.equal(retried.message.replyTo, 'original-reply-target');
  assert.deepEqual(retried.message.from, source.from);
  assert.deepEqual((await f.messageStore.getById(source.id)).lifecycle, source.lifecycle);
});
