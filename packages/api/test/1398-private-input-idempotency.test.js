import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

/**
 * A private input has no History member to carry its admission identity, so the Queue row is the
 * only thing standing between a stable producer key and a second execution. That row is removed on
 * purpose once its last target crosses into processing. The admission winner must outlive it.
 */
describe('#1398 private input idempotency', () => {
  const deliverOnce = (connector, threadId, userId) =>
    connector.delivery.deliverPrivate({
      ownerUserId: userId,
      threadId,
      targetCatId: 'opus',
      idempotencyKey: 'eval-receipt-stable-key',
      content: 'run the scheduled eval',
      from: { kind: 'system', service: 'scheduler' },
      sourceCategory: 'scheduled',
    });

  it('does not start the same work twice when a stable key is replayed after processing', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'private replay');
    const connector = connectorDeliveryHarness();

    const first = await deliverOnce(connector, thread.id, 'user-1');
    assert.equal(first.admitted, true);
    assert.equal(connector.progressed.length, 1, 'the first admission runs the work exactly once');

    // Cross the processing boundary: the durable row is retired by design.
    const claimed = await connector.queue.markProcessingDurable(thread.id, 'user-1', {
      entryId: first.entryId,
      targetCats: ['opus'],
    });
    assert.ok(claimed, 'the admitted entry must be claimable');
    const committed = await connector.queue.commitClaimedAdoptionDurable(
      thread.id,
      'user-1',
      first.entryId,
      'opus',
      'invocation-1',
      Date.now(),
    );
    assert.ok(committed, 'the claimed entry must cross into processing');
    assert.equal(
      await connector.queue.getDurableEntry(thread.id, first.entryId),
      null,
      'the Queue row is retired once its last target is processing',
    );

    // The producer replays the same stable key — a receipt-completion failure is allowed to do this.
    const replay = await deliverOnce(connector, thread.id, 'user-1');

    assert.equal(connector.progressed.length, 1, 'a replay after retirement must not start the work a second time');
    assert.equal(replay.admitted, true, 'the replay is reported as already admitted, not as a refusal');
  });

  const noticeFor = (threadId, userId) => ({
    from: { kind: 'system', service: 'scheduler' },
    userId,
    content: 'Scheduled eval triggered.',
    mentions: [],
    origin: 'callback',
    timestamp: Date.now(),
    threadId,
    source: { connector: 'scheduler', label: 'Scheduler' },
    idempotencyKey: 'eval-receipt-stable-key:notice',
  });

  it('never publishes a visible notice for work the Queue refused', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'refused admission');
    const connector = connectorDeliveryHarness();
    // Stub the seam production uses for this path: admission and notice are now one call, so a
    // refusal has to be observed there rather than at the bare private-row seam.
    connector.queue.enqueueDurableWithVisibleNotice = async () => ({ outcome: 'full' });

    const result = await connector.delivery.deliverVisibleWithPrivateInput({
      ownerUserId: 'user-1',
      threadId: thread.id,
      targetCatId: 'opus',
      idempotencyKey: 'eval-receipt-stable-key',
      content: 'run the scheduled eval',
      from: { kind: 'system', service: 'scheduler' },
      notice: noticeFor(thread.id, 'user-1'),
      sourceCategory: 'scheduled',
    });

    assert.equal(result.admitted, false, 'a refused admission is reported as refused');
    assert.equal(
      (await connector.messageStore.getByThread(thread.id)).length,
      0,
      'a refused admission must leave no visible notice behind',
    );
    assert.equal(connector.progressed.length, 0, 'no work may start');
  });

  it('publishes the visible notice at most once across a replayed stable key', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'replayed notice');
    const connector = connectorDeliveryHarness();
    const send = () =>
      connector.delivery.deliverVisibleWithPrivateInput({
        ownerUserId: 'user-1',
        threadId: thread.id,
        targetCatId: 'opus',
        idempotencyKey: 'eval-receipt-stable-key',
        content: 'run the scheduled eval',
        from: { kind: 'system', service: 'scheduler' },
        notice: noticeFor(thread.id, 'user-1'),
        sourceCategory: 'scheduled',
      });

    const first = await send();
    assert.equal(first.admitted, true);
    assert.ok(first.notice, 'the visible notice is published with its admitted work');
    assert.equal(connector.progressed.length, 1);

    const claimed = await connector.queue.markProcessingDurable(thread.id, 'user-1', {
      entryId: first.entryId,
      targetCats: ['opus'],
    });
    assert.ok(claimed);
    await connector.queue.commitClaimedAdoptionDurable(
      thread.id,
      'user-1',
      first.entryId,
      'opus',
      'invocation-1',
      Date.now(),
    );

    const replay = await send();
    assert.equal(replay.admitted, true, 'the replayed key is already-admitted work, not a refusal');
    assert.equal(connector.progressed.length, 1, 'the replay must not start the work again');
    assert.equal(
      (await connector.messageStore.getByThread(thread.id)).length,
      1,
      'the replay must not publish a second visible notice',
    );
  });
});

/**
 * A receipt that stores only an entry id can tell that a key was used, but not what it was used
 * for. Once the row is retired the row's own fields are gone, so an id-only receipt reports a
 * completely different envelope reusing the key as a successful admission — the caller believes its
 * new payload is queued while nothing of the sort is true.
 */
describe('#1398 private admission receipts bind the envelope, not just the key', () => {
  const retireFirstAdmission = async (connector, threadId, userId, entryId) => {
    await connector.queue.markProcessingDurable(threadId, userId, { entryId, targetCats: ['opus'] });
    await connector.queue.commitClaimedAdoptionDurable(threadId, userId, entryId, 'opus', 'invocation-1', Date.now());
    assert.equal(await connector.queue.getDurableEntry(threadId, entryId), null, 'row retired');
  };

  const deliver = (connector, threadId, userId, overrides = {}) =>
    connector.delivery.deliverPrivate({
      ownerUserId: userId,
      threadId,
      targetCatId: 'opus',
      idempotencyKey: 'eval-receipt-stable-key',
      content: 'run the scheduled eval',
      from: { kind: 'system', service: 'scheduler' },
      sourceCategory: 'scheduled',
      ...overrides,
    });

  it('refuses a different payload that reuses a retired key instead of reporting it admitted', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'receipt collision');
    const connector = connectorDeliveryHarness();

    const first = await deliver(connector, thread.id, 'user-1');
    await retireFirstAdmission(connector, thread.id, 'user-1', first.entryId);

    await assert.rejects(
      () => deliver(connector, thread.id, 'user-1', { content: 'delete the production index' }),
      /identity conflict/i,
      'a changed payload on a settled key is a conflict, never a silent admission',
    );
    assert.equal(connector.progressed.length, 1, 'the conflicting envelope must not start work');
  });

  it('refuses a different target that reuses a retired key', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'receipt target collision');
    const connector = connectorDeliveryHarness();

    const first = await deliver(connector, thread.id, 'user-1');
    await retireFirstAdmission(connector, thread.id, 'user-1', first.entryId);

    await assert.rejects(
      () => deliver(connector, thread.id, 'user-1', { targetCatId: 'codex' }),
      /identity conflict/i,
      'redirecting settled work to another cat is a conflict',
    );
  });

  it('refuses an escalated owner provenance that reuses a retired key', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'receipt provenance collision');
    const connector = connectorDeliveryHarness();

    const first = await deliver(connector, thread.id, 'user-1', { ownerAuthProvenance: 'unknown' });
    await retireFirstAdmission(connector, thread.id, 'user-1', first.entryId);

    await assert.rejects(
      () => deliver(connector, thread.id, 'user-1', { ownerAuthProvenance: 'strict' }),
      /identity conflict/i,
      'a settled key must not be a way to upgrade authority after the fact',
    );
  });

  it('still replays the identical envelope after retirement', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'receipt replay');
    const connector = connectorDeliveryHarness();

    const first = await deliver(connector, thread.id, 'user-1');
    await retireFirstAdmission(connector, thread.id, 'user-1', first.entryId);

    const replay = await deliver(connector, thread.id, 'user-1');
    assert.equal(replay.admitted, true, 'the unchanged envelope is a replay, not a conflict');
    assert.equal(connector.progressed.length, 1, 'and it does not run the work again');
  });
});

/**
 * The visible notice and the private row are one user-facing event. Two separate writes mean the
 * second can fail: either a "triggered" line with nothing behind it, or durable work whose producer
 * was handed an error and reports `trigger_failed` while the work runs anyway.
 */
describe('#1398 visible notice and private admission commit together', () => {
  const noticeFor = (threadId) => ({
    from: { kind: 'system', service: 'scheduler' },
    userId: 'user-1',
    content: 'Scheduled task triggered.',
    mentions: [],
    origin: 'callback',
    timestamp: Date.now(),
    threadId,
    source: { connector: 'scheduler', label: 'Scheduler' },
  });

  const deliverVisible = (connector, threadId, overrides = {}) =>
    connector.delivery.deliverVisibleWithPrivateInput({
      ownerUserId: 'user-1',
      threadId,
      targetCatId: 'opus',
      idempotencyKey: 'scheduled-wake:private',
      content: 'run the scheduled eval',
      from: { kind: 'system', service: 'scheduler' },
      sourceCategory: 'scheduled',
      notice: noticeFor(threadId),
      ...overrides,
    });

  it('admits the work and publishes the notice in one transition', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'visible notice');
    const connector = connectorDeliveryHarness();

    const result = await deliverVisible(connector, thread.id);

    assert.equal(result.admitted, true);
    assert.ok(result.notice, 'the visible line is published');
    assert.ok(connector.messageStore.getById(result.notice.id), 'and it is durable');
    const rows = await connector.queue.listAllDurable(thread.id);
    assert.equal(rows.length, 1, 'exactly one private row backs the notice');
    assert.equal(rows[0].kind, 'private_input', 'and it is private work, not a second History member');
    assert.equal(connector.progressed.length, 1, 'the announced work actually runs');
  });

  it('leaves no durable work behind when the notice half fails', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'notice failure');
    const connector = connectorDeliveryHarness();
    const realAppend = connector.messageStore.append.bind(connector.messageStore);
    connector.messageStore.append = () => {
      throw new Error('history unavailable');
    };

    await assert.rejects(() => deliverVisible(connector, thread.id), /history unavailable/);

    // Observe every durable row, not just the owner-scoped projection: a private row is owned by
    // `system:scheduler`, so an owner-filtered list would be empty whether or not work survived.
    assert.deepEqual(
      await connector.queue.listAllDurable(thread.id),
      [],
      'a failed notice must not leave durable work the caller was told had failed',
    );
    assert.equal(connector.progressed.length, 0, 'and nothing may have started');

    // The rollback must retract the receipt too, or the key becomes a permanent tombstone.
    connector.messageStore.append = realAppend;
    const retry = await deliverVisible(connector, thread.id);
    assert.equal(retry.admitted, true, 'the same key must still be usable after a rolled-back attempt');
    assert.ok(retry.notice, 'and the retry publishes its notice');
    assert.equal(connector.progressed.length, 1, 'the work runs exactly once across both attempts');
  });

  /**
   * The contract a live row must honour, stated here so the Redis suite has something to match.
   *
   * A row that is still live settles its own identity, but settling is not the same as accepting
   * any envelope that reuses the key. The refusal has to happen before the notice is written —
   * otherwise the thread shows a "triggered" line for work that was refused. The Redis backend
   * reached this verdict only after publishing, because its Lua answered `settled` on the row's
   * existence alone and compared fingerprints afterwards in TypeScript.
   */
  it('publishes no notice when a live row is reused by a different envelope', async () => {
    const threadStore = new ThreadStore();
    const thread = await threadStore.create('user-1', 'live row reuse');
    const connector = connectorDeliveryHarness();

    const first = await deliverVisible(connector, thread.id);
    assert.equal(first.admitted, true);
    assert.ok(
      await connector.queue.getDurableEntry(thread.id, first.entryId),
      'the row must still be live — this case is about the live branch, not the receipt',
    );
    const afterFirst = (await connector.messageStore.getByThreadIncludingQueued(thread.id)).map((m) => m.id);

    await assert.rejects(
      () => deliverVisible(connector, thread.id, { content: 'delete the production index' }),
      /identity conflict/i,
      'a live row must refuse a different envelope on its key',
    );

    assert.deepEqual(
      (await connector.messageStore.getByThreadIncludingQueued(thread.id)).map((m) => m.id),
      afterFirst,
      'the refusal must happen before any Message write, so no notice may appear',
    );
    assert.equal(connector.progressed.length, 1, 'and the conflicting envelope never starts work');
  });
});
