import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

function appendQueued(store) {
  return store.append(
    canonicalTestMessageInput({
      threadId: 'thread-f264-gap-f',
      userId: 'owner-1',
      catId: null,
      content: '修正后的正文',
      contentBlocks: [
        { type: 'text', text: '修正后的正文' },
        { type: 'image', url: '/uploads/proof.png' },
      ],
      mentions: ['codex', 'fable5'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
      replyTo: 'parent-message',
    }),
  );
}

describe('F264 Gap F true recall contract (memory store)', () => {
  it('rejects foreign owner and thread before mutating message or drafts', () => {
    const store = new MessageStore();
    const message = appendQueued(store);
    const beforeMessage = structuredClone(store.getById(message.id));

    for (const identity of [
      { ownerUserId: 'foreign-owner', threadId: 'thread-f264-gap-f' },
      { ownerUserId: 'owner-1', threadId: 'thread-foreign' },
    ]) {
      assert.deepEqual(
        store.recallMessageToComposerDraft(message.id, {
          ...identity,
          expectedDraftRevision: 0,
          merge: 'replace',
          recalledAt: 2_000,
        }),
        { kind: 'unauthorized' },
      );
    }

    assert.deepEqual(store.getById(message.id), beforeMessage);
    assert.equal(store.getOwnerComposerDraft('owner-1', 'thread-f264-gap-f'), null);
    assert.equal(store.getOwnerComposerDraft('foreign-owner', 'thread-f264-gap-f'), null);
    assert.equal(store.getOwnerComposerDraft('owner-1', 'thread-foreign'), null);
  });

  it('refuses a body that already left the Queue', () => {
    const store = new MessageStore();
    const message = store.append(
      canonicalTestMessageInput({
        threadId: 'thread-f264-gap-f',
        userId: 'owner-1',
        catId: null,
        content: '没有 custody',
        mentions: [],
        timestamp: 1_000,
        deliveryStatus: 'queued',
      }),
    );
    assert.equal(store.markDelivered(message.id, 1_500).deliveryTransitioned, true);
    assert.deepEqual(
      store.recallMessageToComposerDraft(message.id, {
        ownerUserId: 'owner-1',
        threadId: 'thread-f264-gap-f',
        expectedDraftRevision: 0,
        merge: 'replace',
        recalledAt: 2_000,
      }),
      { kind: 'not_recallable' },
    );
  });

  it('atomically transfers a zero-exposure body into a TTL-0 owner draft and hides the tombstone', () => {
    const store = new MessageStore();
    const message = appendQueued(store);

    const result = store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });

    assert.equal(result.kind, 'recalled');
    assert.equal(result.verdict, 'zero_exposure');
    assert.equal(result.draft.revision, 1);
    assert.equal(result.draft.text, '修正后的正文');
    assert.deepEqual(result.draft.contentBlocks, [
      { type: 'text', text: '修正后的正文' },
      { type: 'image', url: '/uploads/proof.png' },
    ]);
    assert.equal(result.draft.replyTo, 'parent-message');
    assert.deepEqual(result.insertedRange, { start: 0, end: 6 });

    const tombstone = store.getById(message.id);
    assert.equal(tombstone.content, '');
    assert.equal(tombstone.contentBlocks, undefined);
    assert.equal(tombstone.replyTo, undefined);
    assert.equal(tombstone.deliveryStatus, 'canceled');
    assert.equal(tombstone._tombstone, true);
    assert.equal(tombstone.recall.exposure, 'none');
    assert.equal(tombstone.queueCustody, undefined);

    assert.equal(store.getByThread('thread-f264-gap-f', 20, 'owner-1', { includeQueuedUserMessages: true }).length, 0);
    assert.equal(store.getOwnerComposerDraft('owner-1', 'thread-f264-gap-f').text, '修正后的正文');
  });

  it('keeps message, custody and both drafts unchanged on a stale draft revision', () => {
    const store = new MessageStore();
    const message = appendQueued(store);
    const seeded = store.putOwnerComposerDraft('owner-1', 'thread-f264-gap-f', {
      expectedRevision: 0,
      text: '已有草稿',
      updatedAt: 1_500,
    });
    assert.equal(seeded.kind, 'updated');

    const beforeMessage = structuredClone(store.getById(message.id));
    const beforeDraft = structuredClone(store.getOwnerComposerDraft('owner-1', 'thread-f264-gap-f'));
    const result = store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      expectedDraftRevision: 0,
      merge: 'append',
      recalledAt: 2_000,
    });

    assert.deepEqual(result, { kind: 'draft_revision_mismatch', actualRevision: 1 });
    assert.deepEqual(store.getById(message.id), beforeMessage);
    assert.deepEqual(store.getOwnerComposerDraft('owner-1', 'thread-f264-gap-f'), beforeDraft);
  });

  it('blank-line appends once and repeat recall never duplicates the transferred body', () => {
    const store = new MessageStore();
    const message = appendQueued(store);
    assert.equal(
      store.putOwnerComposerDraft('owner-1', 'thread-f264-gap-f', {
        expectedRevision: 0,
        text: '已有草稿',
        updatedAt: 1_500,
      }).kind,
      'updated',
    );

    const first = store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      expectedDraftRevision: 1,
      merge: 'append',
      recalledAt: 2_000,
    });
    assert.equal(first.kind, 'recalled');
    assert.equal(first.draft.text, '已有草稿\n\n修正后的正文');
    assert.deepEqual(first.insertedRange, { start: 6, end: 12 });

    const second = store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      expectedDraftRevision: 2,
      merge: 'append',
      recalledAt: 3_000,
    });
    assert.equal(second.kind, 'already_recalled');
    assert.equal(store.getOwnerComposerDraft('owner-1', 'thread-f264-gap-f').text, '已有草稿\n\n修正后的正文');
  });

  it('clears to a content-free next revision so an old revision-zero tab cannot resurrect stale text', () => {
    const store = new MessageStore();
    assert.equal(
      store.putOwnerComposerDraft('owner-1', 'thread-f264-gap-f', {
        expectedRevision: 0,
        text: '即将发送',
        updatedAt: 1_500,
      }).kind,
      'updated',
    );

    assert.deepEqual(store.clearOwnerComposerDraft('owner-1', 'thread-f264-gap-f', 1, 2_000), {
      kind: 'cleared',
      revision: 2,
    });
    assert.deepEqual(store.getOwnerComposerDraft('owner-1', 'thread-f264-gap-f'), {
      version: 1,
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      revision: 2,
      text: '',
      updatedAt: 2_000,
    });
    assert.deepEqual(
      store.putOwnerComposerDraft('owner-1', 'thread-f264-gap-f', {
        expectedRevision: 0,
        text: '旧标签页正文',
        updatedAt: 2_500,
      }),
      { kind: 'revision_mismatch', actualRevision: 2 },
    );
  });

  it('rejects late extra mutations after recall so a tombstone cannot regain derived body metadata', () => {
    const store = new MessageStore();
    const message = appendQueued(store);
    const recalled = store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });
    assert.equal(recalled.kind, 'recalled');

    assert.equal(store.updateExtra(message.id, { rich: { kind: 'legacy-copy', body: '修正后的正文' } }), null);
    assert.equal(store.getById(message.id).extra, undefined);
  });
});
