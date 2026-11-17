import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admissionFixture, enqueueUser } from './helpers/stop-admission-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

for (const commit of [false, true]) {
  test(`#2008 uncertain record creation retains its exact claim and consumer, committed=${commit}`, async (t) => {
    const h = await admissionFixture(t);
    const source = await enqueueUser(h);
    const hooks = [];
    h.processor.registerEntryCompleteHook(source.entry.id, (_id, status) => hooks.push(status));
    let recordId;
    const create = h.records.create.bind(h.records);
    h.records.create = async (input) => {
      if (commit) recordId = (await create(input)).invocationId;
      throw new Error('record create outcome unavailable');
    };
    await h.processor.requestDrain('thread');
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
    assert.deepEqual(h.starts, []);
    assert.deepEqual(hooks, [], 'uncertainty is not a terminal execution');
    const pending = await h.queue.getDurableEntry('thread', source.entry.id);
    assert.equal(pending.status, 'claimed');
    assert.ok(pending.claimId);
    if (recordId) assert.equal((await h.records.get(recordId)).status, 'queued');
  });
}

test('#2008 a duplicate queued record with another source binding cannot consume or rebind this source', async (t) => {
  const h = await admissionFixture(t);
  const source = await enqueueUser(h);
  const input = {
    threadId: 'thread',
    userId: 'default-user',
    targetCats: ['sonnet'],
    intent: 'execute',
    idempotencyKey: `queue-${source.entry.id}:sonnet`,
    actionLeaseCarrier: { kind: 'none' },
    userMessageId: 'a-different-source',
  };
  const { invocationId } = await h.records.create(input);
  const hooks = [];
  h.processor.registerEntryCompleteHook(source.entry.id, (_id, status) => hooks.push(status));
  await h.processor.requestDrain('thread');
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
  assert.deepEqual(h.starts, []);
  assert.deepEqual(hooks, []);
  assert.equal((await h.records.get(invocationId)).userMessageId, 'a-different-source');
  assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'claimed');
});

for (const fault of ['none', 'lost-binding-receipt', 'binding-changed']) {
  test(`#2008 legacy unbound queued replay keeps exact binding custody: ${fault}`, async (t) => {
    const h = await admissionFixture(t);
    const source = await enqueueUser(h);
    const { invocationId } = await h.records.create({
      threadId: 'thread',
      userId: 'default-user',
      targetCats: ['sonnet'],
      intent: 'execute',
      idempotencyKey: `queue-${source.entry.id}:sonnet`,
      actionLeaseCarrier: { kind: 'none' },
    });
    const hooks = [];
    h.processor.registerEntryCompleteHook(source.entry.id, (_id, status) => hooks.push(status));
    const update = h.records.update.bind(h.records);
    let inject = true;
    h.records.update = async (id, input) => {
      if (inject && input.expectedUserMessageId === null) {
        inject = false;
        if (fault === 'binding-changed') await update(id, { userMessageId: 'racing-source' });
        const result = await update(id, input);
        if (fault === 'lost-binding-receipt') throw new Error('binding committed but acknowledgement unavailable');
        return result;
      }
      return update(id, input);
    };
    await h.processor.requestDrain('thread');
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
    const record = await h.records.get(invocationId);
    assert.equal(record.userMessageId, fault === 'binding-changed' ? 'racing-source' : source.entry.payload.messageId);
    if (fault === 'none') {
      assert.deepEqual(h.starts, ['pending source']);
      assert.deepEqual(hooks, ['succeeded']);
      assert.equal(record.status, 'succeeded');
    } else {
      assert.deepEqual(h.starts, []);
      assert.deepEqual(hooks, []);
      assert.equal(record.status, 'queued');
      assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'claimed');
    }
  });
}
