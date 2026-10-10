import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.ts';
import { readQueueTargetExecution } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueTargetExecutionView.ts';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.ts';

async function pending() {
  const f = createPersistedQueueFixture();
  const delivery = new PersistedQueueDelivery({ messages: f.messages, queue: f.queue, progress: async () => {} });
  const admitted = await delivery.deliver({
    ownerUserId: 'operator',
    threadId: 'thread',
    targetCatId: 'codex-astra',
    ownerAuthProvenance: 'strict',
    content: 'projection fixture',
    idempotencyKey: 'projection:source',
    source: { connector: 'content-review', label: 'projection fixture', meta: {} },
  });
  assert.ok(admitted.message && admitted.entryId);
  const entry = await f.queue.getDurableEntry('thread', admitted.entryId);
  assert.ok(entry);
  return { ...f, entry, source: admitted.message };
}

test('pending view requires one exact canonical row and cannot read or retire it', async (t) => {
  const f = await pending();
  t.after(() => f.close());
  const before = await f.queue.getDurableEntry('thread', f.entry.id);
  const view = await readQueueTargetExecution(f.messages, f.queue, f.source, 'codex-astra');
  assert.equal(view?.kind, 'pending');
  assert.equal(view?.entry.id, f.entry.id);
  assert.deepEqual(await f.queue.getDurableEntry('thread', f.entry.id), before);
  assert.deepEqual(f.messages.getById(f.source.id), f.source);
  assert.equal(f.starts.length, 0);
  for (const [name, row] of [
    ['owner', { ...f.entry, owner: { kind: 'user', userId: 'foreign' } }],
    ['thread', { ...f.entry, threadId: 'foreign' }],
    ['message', { ...f.entry, payload: { ...f.entry.payload, messageId: 'foreign' } }],
    ['persistent source', { ...f.entry, payload: { ...f.entry.payload, sourceRecordId: 'foreign' } }],
    ['sender', { ...f.entry, from: { kind: 'user', userId: 'foreign' } }],
    ['target', { ...f.entry, targets: ['opus'] }],
    ['terminal snapshot', { ...f.entry, status: 'terminal' }],
  ])
    await t.test(name, async () => {
      const queue = { getDurableEntriesForMessages: async () => new Map([[f.source.id, [row]]]) };
      assert.equal(await readQueueTargetExecution(f.messages, queue, f.source, 'codex-astra'), undefined);
    });
  await t.test('ambiguous rows', async () => {
    const queue = { getDurableEntriesForMessages: async () => new Map([[f.source.id, [f.entry, f.entry]]]) };
    assert.equal(await readQueueTargetExecution(f.messages, queue, f.source, 'codex-astra'), undefined);
  });
  await t.test('unavailable Queue is not evidence of a pending target', async () => {
    assert.equal(await readQueueTargetExecution(f.messages, undefined, f.source, 'codex-astra'), undefined);
    await assert.rejects(
      readQueueTargetExecution(
        f.messages,
        {
          getDurableEntriesForMessages: async () => {
            throw new Error('Queue unavailable');
          },
        },
        f.source,
        'codex-astra',
      ),
      /Queue unavailable/,
    );
  });
});

test('actual receiver History survives Queue retirement but rejects foreign or ambiguous witnesses', async (t) => {
  const f = await pending();
  t.after(() => f.close());
  await f.processor.progressOwnedCarrier(f.entry, 'codex-astra');
  const childId = await f.waitForAwakening(f.source.id);
  const source = f.messages.getById(f.source.id);
  const ref = source.lifecycle.dispatchRefs[0];
  const receiver = f.messages.getById(ref.statusMessageId);
  assert.equal(await f.queue.getDurableEntry('thread', f.entry.id), null);
  const view = await readQueueTargetExecution(f.messages, f.queue, source, 'codex-astra');
  assert.equal(view?.kind, 'response');
  assert.equal(view?.response.invocationId, childId);
  for (const [name, altered] of [
    ['missing receiver', null],
    ['owner', { ...receiver, userId: 'foreign' }],
    ['thread', { ...receiver, threadId: 'foreign' }],
    ['cat', { ...receiver, catId: 'opus' }],
    ['target', { ...receiver, lifecycle: { ...receiver.lifecycle, targetId: 'opus' } }],
    ['input', { ...receiver, lifecycle: { ...receiver.lifecycle, inputMessageIds: ['foreign'] } }],
    ['kind', { ...receiver, lifecycle: { ...receiver.lifecycle, kind: 'input' } }],
  ])
    await t.test(name, async () => {
      assert.equal(
        await readQueueTargetExecution({ getById: () => altered }, f.queue, source, 'codex-astra'),
        undefined,
      );
    });
  await t.test('duplicate target refs', async () => {
    assert.equal(
      await readQueueTargetExecution(
        f.messages,
        f.queue,
        {
          ...source,
          lifecycle: { ...source.lifecycle, dispatchRefs: [ref, ref] },
        },
        'codex-astra',
      ),
      undefined,
    );
  });
  await t.test('unavailable receiver is not a delivered verdict', async () => {
    await assert.rejects(
      readQueueTargetExecution(
        {
          getById: () => {
            throw new Error('History unavailable');
          },
        },
        f.queue,
        source,
        'codex-astra',
      ),
      /History unavailable/,
    );
  });
  await f.close();
  assert.equal(
    (await readQueueTargetExecution(f.messages, f.queue, f.messages.getById(f.source.id), 'codex-astra'))?.response
      .status,
    'failed',
  );
  assert.equal(await f.queue.getDurableEntry('thread', f.entry.id), null);
});
