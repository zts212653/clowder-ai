import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { stopFixture as fixture, waitFor } from './helpers/stop-private-fixture.js';

for (const legacy of [false, true])
  test(`${legacy ? 'legacy' : 'exact'} Stop after visible withdrawal does not start the hidden backlog`, async (t) => {
    const h = await fixture(t);
    const pending = await h.send('visible queued source');
    const notices = [];
    for (let i = 0; i < 3; i++) {
      const notice = h.messages.append({
        from: { kind: 'system', service: 'worktree-lifecycle' },
        userId: 'owner',
        threadId: 'thread',
        content: `notice ${i}`,
        mentions: [],
        timestamp: Date.now(),
      });
      notices.push(notice);
      await h.queue.enqueueDurable(h.privateInput(`internal-${i}`));
    }
    const before = await h.app.inject({
      method: 'GET',
      url: '/api/threads/thread/queue',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.deepEqual(
      before.json().queue.map((row) => row.id),
      [pending.entry.id],
      'reproduce the invisible-work distinction',
    );
    const withdrawn = await h.app.inject({
      method: 'DELETE',
      url: `/api/threads/thread/queue/${encodeURIComponent(pending.entry.id)}`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(withdrawn.statusCode, 200);
    assert.equal((await h.stop(legacy)).statusCode, 200);
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus'));
    assert.deepEqual(h.starts, ['active'], 'one Stop must not drain a succession of hidden old invocations');
    assert.deepEqual(await h.queue.listAllDurable('thread'), []);
    for (const notice of notices) assert.deepEqual(await h.messages.getById(notice.id), notice);
    const reopened = new InvocationQueue(h.ledger);
    await reopened.hydrateFromLedger();
    assert.deepEqual(await reopened.listAllDurable('thread'), [], 'stopped work must not return after reopening');
    const replay = await reopened.enqueueDurable(h.privateInput('internal-0'));
    assert.equal(replay.deduped, true);
    assert.equal(replay.entry, undefined, 'the original admission receipt must prevent replay');
    await h.send('fresh explicit input');
    await h.processor.requestDrain('thread');
    await waitFor(() => h.starts.includes('fresh explicit input'));
    assert.deepEqual(h.starts, ['active', 'fresh explicit input']);
  });

test('Stop captures only the pending private work of that owner and member, before later arrivals', async (t) => {
  const h = await fixture(t);
  const old = await h.queue.enqueueDurable(h.privateInput('old-hidden'));
  const sibling = await h.queue.enqueueDurable(h.privateInput('other-member', { targetCats: ['codex'] }));
  const foreign = await h.queue.enqueueDurable(h.privateInput('other-owner', { userId: 'foreign' }));
  const elsewhere = await h.queue.enqueueDurable(h.privateInput('other-thread', { threadId: 'elsewhere' }));
  // Arrives after the actual user abort, while provider/History cleanup still awaits.
  const cancel = h.tracker.cancel.bind(h.tracker);
  h.tracker.cancel = (...args) => {
    const result = cancel(...args);
    h.queue.enqueueDurableNow(h.privateInput('new-hidden-after-stop'));
    return result;
  };
  assert.equal((await h.stop()).statusCode, 200);
  await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'opus'));
  assert.ok(!h.starts.includes('old-hidden'), 'the pre-stop hidden wake was retired');
  assert.ok(
    h.starts.includes('new-hidden-after-stop'),
    'Stop does not create a permanent pause or swallow new admission',
  );
  assert.ok(h.starts.includes('other-member'), 'independent member work is unaffected');
  assert.ok(h.starts.includes('other-owner') || (await h.queue.getDurableEntry('thread', foreign.entry.id)));
  assert.ok(await h.queue.getDurableEntry('elsewhere', elsewhere.entry.id));
  assert.equal(await h.queue.getDurableEntry('thread', old.entry.id), null);
  assert.equal(await h.queue.getDurableEntry('thread', sibling.entry.id), null);
});
