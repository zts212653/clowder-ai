/** A2A follow-ups use independent canonical Queue admission; no route-local custody or inline worklist. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.ts';

function admit(f, targets = ['codex'], extra = {}) {
  const from = { kind: 'agent', catId: 'opus' };
  return f.queue.send(
    f.messages,
    {
      userId: 'owner',
      threadId: 'follow-up',
      from,
      content: '请分别接手',
      mentions: targets,
      timestamp: 100,
      deliveryStatus: 'queued',
      idempotencyKey: 'original-response-follow-up',
    },
    {
      kind: 'message_wake',
      userId: 'owner',
      threadId: 'follow-up',
      from,
      content: '请分别接手',
      targetCats: targets,
      sourceCategory: 'a2a',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      autoExecute: true,
      ...extra,
    },
  );
}

test('deferred multi-target follow-up has one atomic source and one durable fanout row', async () => {
  const f = createPersistedQueueFixture(undefined, { autoDrain: false });
  try {
    const a = await admit(f, ['codex', 'sonnet']);
    assert.deepEqual(a.entry.targets, ['codex', 'sonnet']);
    assert.equal(a.entry.payload.messageId, a.message.id);
    assert.equal(a.entry.from.catId, 'opus');
    assert.equal(f.queue.list('follow-up', 'owner').length, 1);
    assert.equal(f.messages.getById(a.message.id).from.catId, 'opus');
    assert.equal(Object.hasOwn(a.message, 'queueCustody'), false);
    assert.equal(f.starts.length, 0);
  } finally {
    await f.close();
  }
});

test('concurrent follow-up admission keeps original source and target identity', async () => {
  const f = createPersistedQueueFixture(undefined, { autoDrain: false });
  try {
    const [a, b] = await Promise.all([admit(f), admit(f)]);
    assert.equal(a.message.id, b.message.id);
    assert.equal(a.entry.id, b.entry.id);
    assert.equal(f.queue.list('follow-up', 'owner').length, 1);
    assert.equal(f.starts.length, 0);
  } finally {
    await f.close();
  }
});

test('deferred follow-up survives Queue reload without source backfill or a second owner', async () => {
  const f = createPersistedQueueFixture(undefined, { autoDrain: false });
  try {
    const a = await admit(f);
    const restored = new InvocationQueue(f.ledger);
    await restored.hydrateFromLedger(f.messages);
    const rows = restored.list('follow-up', 'owner');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.messageId, a.message.id);
    assert.deepEqual(rows[0].targets, ['codex']);
    assert.equal(rows[0].execution.ownerAuthProvenance, 'strict');
  } finally {
    await f.close();
  }
});

test('receiver admission retires pending follow-up without waiting for reading', async () => {
  const f = createPersistedQueueFixture(undefined, { autoDrain: false });
  try {
    const a = await admit(f);
    await f.processor.requestDrain('follow-up');
    const child = await f.waitForAwakening(a.message.id);
    const delivered = f.messages.getById(a.message.id);
    const ref = delivered.lifecycle.dispatchRefs[0];
    assert.equal(f.queue.list('follow-up', 'owner').length, 0);
    assert.equal(ref.inputRead?.status === 'read', false);
    assert.equal(f.messages.getById(ref.statusMessageId).lifecycle.invocationId, child);
    assert.equal(f.starts.length, 1);
  } finally {
    await f.close();
  }
});

test('lost acknowledgement of retired follow-up does not schedule another receiver', async () => {
  const f = createPersistedQueueFixture(undefined, { autoDrain: false });
  try {
    const a = await admit(f);
    await f.processor.requestDrain('follow-up');
    await f.waitForAwakening(a.message.id);
    const replay = await admit(f);
    assert.equal(replay.deduped, true);
    assert.equal(replay.message.id, a.message.id);
    assert.equal(replay.entry, undefined);
    await f.processor.requestDrain('follow-up');
    assert.equal(f.starts.length, 1);
    assert.equal(f.queue.list('follow-up', 'owner').length, 0);
  } finally {
    await f.close();
  }
});
