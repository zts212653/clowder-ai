import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function custody(overrides = {}) {
  return {
    version: 1,
    entryId: 'entry-1',
    revision: 1,
    intent: 'user_message',
    status: 'queued',
    allTargetCats: ['codex', 'fable5'],
    pendingTargetCats: ['codex', 'fable5'],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function appendQueued(store, queueCustody = custody()) {
  return store.append({
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
    queueCustody,
    replyTo: 'parent-message',
  });
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

  it('refuses a queued body without durable Queue custody', () => {
    const store = new MessageStore();
    const message = store.append({
      threadId: 'thread-f264-gap-f',
      userId: 'owner-1',
      catId: null,
      content: '没有 custody',
      mentions: [],
      timestamp: 1_000,
      deliveryStatus: 'queued',
    });
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
    assert.deepEqual(tombstone.queueCustody.pendingTargetCats, []);
    assert.equal(tombstone.queueCustody.status, 'terminal');
    assert.deepEqual(new Set(tombstone.queueCustody.withdrawnByCatIds), new Set(['codex', 'fable5']));

    assert.equal(store.getByThread('thread-f264-gap-f', 20, 'owner-1', { includeQueuedUserMessages: true }).length, 0);
    assert.equal(store.getOwnerComposerDraft('owner-1', 'thread-f264-gap-f').text, '修正后的正文');
  });

  it('derives terminal recall custody once and closes every active reminder attempt', () => {
    const store = new MessageStore();
    const message = appendQueued(
      store,
      custody({
        reminderAttempts: [
          {
            id: 'reminder-requested',
            targetCatId: 'codex',
            invocationId: 'child-codex',
            state: 'requested',
            requestedAt: 120,
          },
          {
            id: 'reminder-delivered',
            targetCatId: 'fable5',
            invocationId: 'child-fable5',
            state: 'delivered',
            requestedAt: 130,
            deliveredAt: 140,
          },
        ],
      }),
    );

    const result = store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });

    assert.equal(result.kind, 'recalled');
    assert.deepEqual(result.message.queueCustody.reminderAttempts, [
      {
        id: 'reminder-requested',
        targetCatId: 'codex',
        invocationId: 'child-codex',
        state: 'missed',
        requestedAt: 120,
        missedAt: 2_000,
        missedReason: 'source_withdrawn',
      },
      {
        id: 'reminder-delivered',
        targetCatId: 'fable5',
        invocationId: 'child-fable5',
        state: 'missed',
        requestedAt: 130,
        deliveredAt: 140,
        missedAt: 2_000,
        missedReason: 'source_withdrawn',
      },
    ]);
  });

  it('preserves content-free exact exposure truth and withdraws only unread siblings', () => {
    const store = new MessageStore();
    const message = appendQueued(
      store,
      custody({
        seenByCatIds: ['codex'],
        seenInvocationIdByCatId: { codex: 'child-codex' },
        awakenedInvocationIdByCatId: { codex: 'child-codex' },
        awakenedAtByCatId: { codex: 1_400 },
        bodyExposures: [{ targetCatId: 'codex', invocationId: 'child-codex', seenAt: 1_500 }],
      }),
    );
    store.visibilitySeq.set(message.id, 1_400);
    const [published] = store.getByThreadAfter('thread-f264-gap-f', undefined, 20, 'owner-1', {
      includeQueuedUserMessages: true,
    });
    assert.ok(published?.visibilitySeq);

    const result = store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });

    assert.equal(result.kind, 'recalled');
    assert.equal(result.verdict, 'exposed');
    assert.deepEqual(result.message.recall.exposures, [
      { targetCatId: 'codex', invocationId: 'child-codex', seenAt: 1_500 },
    ]);
    assert.deepEqual(result.message.queueCustody.seenByCatIds, ['codex']);
    assert.deepEqual(result.message.queueCustody.pendingTargetCats, []);
    assert.deepEqual(result.message.queueCustody.withdrawnByCatIds, ['codex', 'fable5']);
    assert.equal(result.message.queueCustody.awakenedInvocationIdByCatId, undefined);
    assert.equal(result.message.queueCustody.awakenedAtByCatId, undefined);
    assert.equal(result.message.content, '');

    const ownerHistory = store.getByThread('thread-f264-gap-f', 20, 'owner-1', {
      includeQueuedUserMessages: true,
      includeRecalledUserMessages: true,
    });
    assert.equal(ownerHistory.length, 1);
    assert.equal(ownerHistory[0].id, message.id);
    assert.equal(ownerHistory[0].content, '');
    const [incrementalTombstone] = store.getByThreadAfter('thread-f264-gap-f', undefined, 20, 'owner-1', {
      includeRecalledUserMessages: true,
    });
    assert.equal(incrementalTombstone.id, message.id);
    assert.equal(incrementalTombstone.visibilitySeq, published.visibilitySeq, 'recall retains the published cursor');
    assert.equal(store.getByThread('thread-f264-gap-f').length, 0, 'cat/default reads never publish recalled body');
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

  it('recalls an already published handled source without erasing its exact handling lineage', () => {
    const store = new MessageStore();
    const message = appendQueued(
      store,
      custody({
        status: 'terminal',
        pendingTargetCats: [],
        seenByCatIds: ['codex'],
        seenInvocationIdByCatId: { codex: 'child-handled' },
        bodyExposures: [{ targetCatId: 'codex', invocationId: 'child-handled', seenAt: 1_500 }],
        handledByCatIds: ['codex', 'fable5'],
      }),
    );
    assert.equal(store.markDelivered(message.id, 1_800).deliveryTransitioned, true);

    const result = store.recallMessageToComposerDraft(message.id, {
      ownerUserId: 'owner-1',
      threadId: 'thread-f264-gap-f',
      expectedDraftRevision: 0,
      merge: 'replace',
      recalledAt: 2_000,
    });
    assert.equal(result.kind, 'recalled');
    assert.equal(result.verdict, 'exposed');
    assert.deepEqual(result.message.queueCustody.handledByCatIds, ['codex', 'fable5']);
    assert.deepEqual(result.message.queueCustody.withdrawnByCatIds, []);
    assert.equal(result.message.content, '');
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
