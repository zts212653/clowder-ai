import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

const owned = ownedRedisFixture('queue-independent-targets');

function admit(h, id, targets) {
  const from = { kind: 'user', userId: 'owner' };
  return h.queue.send(
    h.messages,
    {
      from,
      userId: 'owner',
      threadId: 'thread',
      content: id,
      mentions: targets,
      timestamp: Date.now(),
      deliveryStatus: 'queued',
      idempotencyKey: id,
    },
    {
      from,
      userId: 'owner',
      threadId: 'thread',
      kind: 'conversation_input',
      content: id,
      targetCats: targets,
      intent: 'execute',
      ownerAuthProvenance: 'strict',
      idempotencyKey: id,
    },
  );
}

test('two idle siblings start before either finishes, and completing one preserves the other live attempt', async (t) => {
  const h = await stopFixture(t, { idle: true });
  h.tracker.start('thread', 'opus', 'owner', ['opus'], 'busy-original');
  const shared = await h.send('active', ['opus', 'codex', 'gemini']);
  const completed = [];
  for (const catId of ['opus', 'codex', 'gemini'])
    h.processor.registerEntryCompleteHook(shared.entry.id, () => completed.push(catId), catId);

  await h.processor.requestDrain('thread');
  await waitFor(() => h.starts.length === 2);
  assert.deepEqual((await h.queue.getDurableEntry('thread', shared.entry.id)).targets, ['opus']);
  assert.deepEqual(
    (await h.messages.getById(shared.message.id)).lifecycle.dispatchRefs.map((ref) => ref.targetId),
    ['codex', 'gemini'],
  );
  assert.equal(h.tracker.getExecutionId('thread', 'opus'), 'busy-original');
  assert.deepEqual(completed, []);

  h.finishMember('codex');
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'codex'));
  assert.deepEqual(completed, ['codex']);
  assert.equal(
    h.queue.findAdmittedEntriesForMessages('thread', [shared.message.id], 'owner', 'gemini').length,
    1,
    'another execution still owns the shared source for gemini',
  );
  await h.send('follow-up', ['codex']);
  await h.processor.requestDrain('thread');
  await waitFor(() => h.starts.includes('follow-up'));

  h.tracker.complete('thread', 'opus');
  await h.processor.requestDrain('thread');
  await waitFor(() => h.starts.filter((content) => content === 'active').length === 3);
  h.finishMember('opus');
  h.finishMember('gemini');
  await waitFor(() => completed.length === 3);
  assert.deepEqual(new Set(completed), new Set(['opus', 'codex', 'gemini']));
  assert.deepEqual(h.queue.findAdmittedEntriesForMessages('thread', [shared.message.id]), []);
});

test('a stopped member suppression fence does not delay an idle sibling or its next input', async (t) => {
  const h = await stopFixture(t, { idle: true });
  h.processor.suppressAutoResume('thread', 'opus');
  const shared = await h.send('shared', ['opus', 'codex']);
  await h.send('follow-up', ['codex']);
  await h.processor.requestDrain('thread');
  await waitFor(() => h.starts.length === 2);
  assert.deepEqual(h.starts, ['shared', 'follow-up']);
  assert.deepEqual((await h.queue.getDurableEntry('thread', shared.entry.id)).targets, ['opus']);
  assert.equal(h.tracker.has('thread', 'opus'), false);
});

for (const storage of ['memory', 'redis']) {
  for (const kind of ['public', 'private']) {
    test(`${storage}: partial ${kind} source survives restart and original replay without repeating a recipient`, async (t) => {
      const memoryLedger = new InMemoryQueueLedgerStore();
      const memoryMessages = new MessageStore();
      const prefix = `${randomUUID()}:`;
      const storageOptions = () => {
        if (storage === 'memory') return { ledger: memoryLedger, messages: memoryMessages };
        const client = owned.client(prefix);
        return {
          ledger: new RedisQueueLedgerStore(client),
          messages: new RedisMessageStore(client, { ttlSeconds: 0 }),
        };
      };
      const h = await stopFixture(t, { idle: true, ...storageOptions() });
      h.tracker.start('thread', 'opus', 'owner', ['opus'], 'busy-original');
      const privateInput = h.privateInput('shared-private', { targetCats: ['opus', 'codex'] });
      const send = (fixture) =>
        kind === 'private'
          ? fixture.queue.enqueueDurable(privateInput)
          : admit(fixture, 'shared-public', ['opus', 'codex']);
      const admitted = await send(h);
      await h.processor.requestDrain('thread');
      await waitFor(() => h.starts.length === 1 && !h.processor.hasProcessingSlotReservation('thread', 'codex'));
      assert.deepEqual((await h.queue.getDurableEntry('thread', admitted.entry.id)).targets, ['opus']);

      const reopened = await stopFixture(t, { idle: true, ...storageOptions() });
      await reopened.queue.hydrateFromLedger(reopened.messages);
      assert.equal((await send(reopened)).deduped, true);
      assert.deepEqual((await reopened.queue.getDurableEntry('thread', admitted.entry.id)).targets, ['opus']);
      await reopened.processor.requestDrain('thread');
      await waitFor(
        () => reopened.starts.length === 1 && !reopened.processor.hasProcessingSlotReservation('thread', 'opus'),
      );
      assert.equal(await reopened.queue.getDurableEntry('thread', admitted.entry.id), null);
      assert.equal((await send(reopened)).deduped, true);
      assert.deepEqual(reopened.queue.list('thread', 'owner'), []);
      assert.equal(reopened.starts.length, 1);
      if (kind === 'public') {
        const source = await reopened.messages.getById(admitted.message.id);
        assert.deepEqual(
          source.lifecycle.dispatchRefs.map((ref) => ref.targetId),
          ['codex', 'opus'],
        );
        assert.equal(
          (await reopened.messages.getByThread('thread')).filter((message) => message.id === source.id).length,
          1,
        );
      } else {
        await assert.rejects(
          () => reopened.queue.enqueueDurable({ ...privateInput, content: 'changed payload' }),
          /identity conflict/i,
        );
      }
    });
  }
}
