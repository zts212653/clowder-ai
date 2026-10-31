import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IMessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { canonicalTestMessageInput } from './message-from-fixtures.js';

const request = {
  userId: 'owner',
  catId: 'codex61-sol',
  threadId: 'restore',
  content: '@co-creator\n请重启',
  mentions: [],
  mentionsUser: true,
  timestamp: 100,
};

export function registerMentionRestorationTests(make: () => IMessageStore) {
  test('a canceled latest source cannot be handled before a reread or erase its valid predecessor', async () => {
    const store = make();
    const first = await store.append(canonicalTestMessageInput(request));
    const queued = await store.append(
      canonicalTestMessageInput({ ...request, timestamp: 101, deliveryStatus: 'queued' }),
    );
    const revision = (await store.getUserMentionStateRevisions('owner'))[queued.threadId];
    await store.markCanceled(queued.id);
    assert.equal(await store.resolveUserMentionRequest('owner', queued.threadId, queued.id, revision), false);
    assert.deepEqual(
      (await store.listUserMentionRequests('owner')).map((m) => m.id),
      [first.id],
    );
  });
  test('last bulk receipt is owner scoped, persists in message owner, and is consumed only once', async () => {
    const store = make();
    const first = await store.append(canonicalTestMessageInput(request));
    const result = await store.handleUserMentionRequests('owner', [{ threadId: first.threadId, messageId: first.id }]);
    assert.ok(result);
    assert.deepEqual(await store.getLastUserMentionHandling('owner'), { ...result, remaining: 1 });
    assert.equal(await store.getLastUserMentionHandling('other'), null);
    assert.deepEqual(await store.undoUserMentionHandling('owner', result.undoId), { restored: 1 });
    assert.equal(await store.getLastUserMentionHandling('owner'), null);
    assert.equal(await store.undoUserMentionHandling('owner', result.undoId), null);
  });

  test('remaining undo count tracks single restore, replies and deleted sources without consuming the receipt', async () => {
    const store = make();
    const rows = await Promise.all(
      ['a', 'b', 'c', 'd'].map((threadId) => store.append(canonicalTestMessageInput({ ...request, threadId }))),
    );
    const action = await store.handleUserMentionRequests(
      'owner',
      rows.map((row) => ({ threadId: row.threadId, messageId: row.id })),
    );
    assert.ok(action);
    assert.equal((await store.getLastUserMentionHandling('owner'))?.remaining, 4);
    const revisions = await store.getUserMentionStateRevisions('owner');
    assert.equal(await store.restoreUserMentionRequest('owner', rows[0].threadId, rows[0].id, revisions.a), true);
    assert.equal((await store.getLastUserMentionHandling('owner'))?.remaining, 3);
    await store.append(
      canonicalTestMessageInput({ ...request, threadId: 'b', catId: null, mentionsUser: false, timestamp: 101 }),
    );
    await store.softDelete(rows[2].id, 'owner');
    assert.deepEqual(await store.getLastUserMentionHandling('owner'), { ...action, remaining: 1 });
    assert.deepEqual(await store.getLastUserMentionHandling('owner'), { ...action, remaining: 1 });
    assert.deepEqual(await store.undoUserMentionHandling('owner', action.undoId), { restored: 1 });
    assert.equal(await store.getLastUserMentionHandling('owner'), null);
  });

  test('single restore cannot overwrite new request; old batch undo cannot reopen a restored and rehandled source', async () => {
    const store = make();
    const first = await store.append(canonicalTestMessageInput(request));
    const batch = await store.handleUserMentionRequests('owner', [{ threadId: first.threadId, messageId: first.id }]);
    assert.ok(batch);
    let revisions = await store.getUserMentionStateRevisions('owner');
    const snapshot = [{ threadId: first.threadId, messageId: first.id, expectedRevision: revisions[first.threadId] }];
    assert.equal(
      await store.restoreUserMentionRequest('other', first.threadId, first.id, revisions[first.threadId]),
      false,
    );
    assert.equal(
      await store.restoreUserMentionRequest('owner', first.threadId, first.id, revisions[first.threadId]),
      true,
    );
    assert.equal(await store.handleUserMentionRequests('owner', snapshot), null);
    revisions = await store.getUserMentionStateRevisions('owner');
    assert.equal(
      await store.resolveUserMentionRequest('owner', first.threadId, first.id, revisions[first.threadId]),
      true,
    );
    assert.deepEqual(await store.undoUserMentionHandling('owner', batch.undoId), { restored: 0 });
    assert.deepEqual(await store.listUserMentionRequests('owner'), []);
    const fresh = await store.append(canonicalTestMessageInput({ ...request, timestamp: 101 }));
    revisions = await store.getUserMentionStateRevisions('owner');
    assert.equal(
      await store.restoreUserMentionRequest('owner', first.threadId, first.id, revisions[first.threadId]),
      false,
    );
    assert.deepEqual(
      (await store.listUserMentionRequests('owner')).map((m) => m.id),
      [fresh.id],
    );
  });

  test('deleted request cannot be restored or exposed in handled history', async () => {
    const store = make();
    const row = await store.append(canonicalTestMessageInput(request));
    await store.resolveUserMentionRequest('owner', row.threadId, row.id);
    await store.softDelete(row.id, 'owner');
    const revisions = await store.getUserMentionStateRevisions('owner');
    assert.equal(await store.restoreUserMentionRequest('owner', row.threadId, row.id, revisions[row.threadId]), false);
    assert.deepEqual(await store.listHandledUserMentions('owner'), []);
  });

  test('restoring an older handled row preserves closure barrier, falls back after cancellation, and a human reply closes it', async () => {
    const store = make();
    const first = await store.append(canonicalTestMessageInput(request));
    await store.resolveUserMentionRequest('owner', first.threadId, first.id);
    const second = await store.append(canonicalTestMessageInput({ ...request, timestamp: 101 }));
    await store.resolveUserMentionRequest('owner', second.threadId, second.id);
    let revisions = await store.getUserMentionStateRevisions('owner');
    assert.equal(
      await store.restoreUserMentionRequest('owner', first.threadId, first.id, revisions[first.threadId]),
      true,
    );
    assert.deepEqual(
      (await store.listUserMentionRequests('owner')).map((m) => m.id),
      [first.id],
    );
    await store.augmentStreamMetadata(second.id, { mentionsUser: true });
    assert.deepEqual(
      (await store.listUserMentionRequests('owner')).map((m) => m.id),
      [first.id],
    );
    const queued = await store.append(
      canonicalTestMessageInput({ ...request, timestamp: 102, deliveryStatus: 'queued' }),
    );
    await store.markCanceled(queued.id);
    assert.deepEqual(
      (await store.listUserMentionRequests('owner')).map((m) => m.id),
      [first.id],
    );
    await store.append(canonicalTestMessageInput({ ...request, catId: null, mentionsUser: false, timestamp: 103 }));
    assert.deepEqual(await store.listUserMentionRequests('owner'), []);
    revisions = await store.getUserMentionStateRevisions('owner');
    assert.equal(
      await store.restoreUserMentionRequest('owner', second.threadId, second.id, revisions[first.threadId]),
      true,
    );
    assert.deepEqual(
      (await store.listUserMentionRequests('owner')).map((m) => m.id),
      [second.id],
    );
  });
}
