import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.ts';

// Real MessageStore, admission and QueueProcessor; only the provider is controlled.
// Pause the adapter's first lookup while an identical winner is adopted and retired.
for (const visibility of ['public', 'whisper']) {
  test(`concurrent retired ${visibility} winner acknowledges one source and execution`, async (t) => {
    const f = createPersistedQueueFixture();
    t.after(() => f.close());
    const input = {
      ownerUserId: 'isolated-owner',
      threadId: 'isolated-replay-race',
      targetCatId: 'opus',
      idempotencyKey: `retired-race:${visibility}`,
      content: 'one logical source',
      ownerAuthProvenance: 'strict',
      sourceCategory: 'producer_return',
      source: { connector: 'review', label: 'review', meta: {} },
      ...(visibility === 'whisper' ? { visibility, whisperTo: ['opus'] } : {}),
    };
    const lookup = f.messages.getByIdempotencyKey.bind(f.messages);
    let winner;
    f.messages.getByIdempotencyKey = async (...args) => {
      const before = await lookup(...args);
      f.messages.getByIdempotencyKey = lookup;
      assert.equal(before, null);
      winner = await f.delivery.deliver(input);
      await f.waitForAwakening(winner.message.id);
      assert.equal(await f.queue.getDurableEntry(input.threadId, winner.entryId), null);
      return before;
    };
    const replay = await f.delivery.deliver(input);
    assert.equal(replay.state, 'already_processing');
    assert.equal(replay.message.id, winner.message.id);
    assert.equal(replay.entryId, winner.entryId);
    assert.equal(f.starts.length, 1);
    assert.equal(f.records.size, 1);
    assert.deepEqual(await f.ledger.list(input.threadId), []);
    assert.equal(f.messages.getByThread(input.threadId).filter((m) => m.id === replay.message.id).length, 1);
    for (const altered of [
      { ...input, content: 'different payload' },
      { ...input, source: { ...input.source, connector: 'foreign' } },
      visibility === 'whisper'
        ? { ...input, whisperTo: ['opus', 'codex'] }
        : { ...input, visibility: 'whisper', whisperTo: ['opus'] },
    ]) {
      assert.equal((await f.delivery.deliver(altered)).state, 'conflict');
    }
    await f.close();
    const settledReplay = await f.delivery.deliver(input);
    assert.ok(['already_processing', 'terminal_owned'].includes(settledReplay.state));
    assert.equal(settledReplay.message.id, winner.message.id);
    assert.equal(f.starts.length, 1);
    assert.deepEqual(await f.ledger.list(input.threadId), []);
  });
}
