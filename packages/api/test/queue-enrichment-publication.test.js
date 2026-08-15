/**
 * F220 intake — ordered, frozen, bounded queue_updated publication.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { emitQueueUpdated } = await import('../dist/utils/queue-enrichment.js');

describe('F220 intake: queue snapshot publication ordering', () => {
  const makeEntry = (overrides = {}) => ({
    id: 'queue-entry',
    threadId: 't1',
    userId: 'u1',
    content: 'queued work',
    messageId: 'msg-entry',
    mergedMessageIds: [],
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'queued',
    createdAt: 1,
    autoExecute: false,
    priority: 'normal',
    ...overrides,
  });

  const makeWithdrawnCustody = (overrides = {}) => ({
    version: 1,
    entryId: 'withdrawn-entry',
    revision: 2,
    ownerAuthProvenance: 'strict',
    intent: 'execute',
    status: 'terminal',
    allTargetCats: ['opus'],
    pendingTargetCats: [],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    withdrawnByCatIds: ['opus'],
    withdrawnAtByCatId: { opus: 20 },
    priority: 'normal',
    createdAt: 1,
    updatedAt: 20,
    ...overrides,
  });

  it('serializes same-scope snapshots while a different user remains independent', async () => {
    const emitted = [];
    let releaseOlder;
    let olderStarted;
    const olderStartedPromise = new Promise((resolve) => {
      olderStarted = resolve;
    });
    const messageStore = {
      getById: async (messageId) => {
        if (messageId === 'msg-older') {
          olderStarted();
          await new Promise((resolve) => {
            releaseOlder = resolve;
          });
        }
        return messageId === 'msg-terminal' ? { id: messageId, queueCustody: makeWithdrawnCustody() } : null;
      },
    };
    const socketManager = {
      emitToUser: (userId, _event, data) =>
        emitted.push({
          userId,
          action: data.action,
          queue: data.queue,
          messageReceipts: data.messageReceipts,
        }),
    };

    const older = emitQueueUpdated(
      socketManager,
      'u1',
      't1',
      [makeEntry({ id: 'older', messageId: 'msg-older' })],
      messageStore,
      'older',
    );
    await olderStartedPromise;
    const newer = emitQueueUpdated(socketManager, 'u1', 't1', [], messageStore, 'newer', {
      receiptMessageIds: ['msg-terminal'],
    });
    const independent = emitQueueUpdated(socketManager, 'u2', 't1', [], messageStore, 'independent');

    try {
      await independent;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        emitted.filter((event) => event.userId === 'u1'),
        [],
        'newer same-scope snapshot must wait behind the older enrichment',
      );
      assert.deepEqual(
        emitted.filter((event) => event.userId === 'u2').map((event) => event.action),
        ['independent'],
        'different user scope must not share the tail',
      );
    } finally {
      releaseOlder?.();
      await Promise.allSettled([older, newer, independent]);
    }

    assert.deepEqual(
      emitted.filter((event) => event.userId === 'u1').map((event) => event.action),
      ['older', 'newer'],
    );
    assert.deepEqual(emitted.find((event) => event.action === 'newer')?.messageReceipts, [
      {
        messageId: 'msg-terminal',
        queueReceipt: {
          version: 1,
          entryId: 'withdrawn-entry',
          targets: [{ catId: 'opus', state: 'withdrawn', withdrawnAt: 20 }],
          reminderAttempts: [],
        },
      },
    ]);
  });

  it('freezes mutable queue entries at publication call time', async () => {
    const emitted = [];
    let releaseLookup;
    let lookupStarted;
    const lookupStartedPromise = new Promise((resolve) => {
      lookupStarted = resolve;
    });
    const messageStore = {
      getById: async () => {
        lookupStarted();
        await new Promise((resolve) => {
          releaseLookup = resolve;
        });
        return null;
      },
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };
    const entry = makeEntry({ queuedNotifiedByCatIds: ['opus'] });

    const publication = emitQueueUpdated(socketManager, 'u1', 't1', [entry], messageStore, 'frozen');
    await lookupStartedPromise;
    entry.targetCats.push('codex');
    entry.queuedNotifiedByCatIds.push('codex');
    releaseLookup();
    await publication;

    assert.deepEqual(emitted[0].queue[0].targetCats, ['opus']);
    assert.deepEqual(emitted[0].queue[0].queuedNotifiedByCatIds, ['opus']);
    assert.deepEqual(emitted[0].queue[0].targetStates, { opus: 'notified' });
  });

  it('falls back to a projected raw snapshot after the enrichment deadline and releases the tail', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const emitted = [];
    let lookupStarted;
    const lookupStartedPromise = new Promise((resolve) => {
      lookupStarted = resolve;
    });
    const messageStore = {
      getById: async () => {
        lookupStarted();
        return new Promise(() => {});
      },
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };
    const stalledEntry = makeEntry({ id: 'stalled', messageId: 'msg-stalled' });
    let stalledSettled = false;
    let followingSettled = false;

    const stalled = emitQueueUpdated(socketManager, 'u1', 't1', [stalledEntry], messageStore, 'stalled').then(() => {
      stalledSettled = true;
    });
    await lookupStartedPromise;
    const following = emitQueueUpdated(socketManager, 'u1', 't1', [], messageStore, 'following').then(() => {
      followingSettled = true;
    });

    t.mock.timers.tick(2_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stalledSettled, true, 'deadline must settle the stalled head publication');
    assert.equal(followingSettled, true, 'deadline must release the next same-scope publication');
    await Promise.all([stalled, following]);
    assert.deepEqual(
      emitted.map((event) => ({ action: event.action, targetStates: event.queue[0]?.targetStates })),
      [
        { action: 'stalled', targetStates: { opus: 'queued' } },
        { action: 'following', targetStates: undefined },
      ],
    );
  });

  it('keeps timely message enrichment and legacy optional queue fields compatible', async () => {
    const emitted = [];
    const messageStore = {
      getById: async () => ({
        contentBlocks: [{ kind: 'text', text: 'preview text' }],
        replyTo: 'msg-parent',
      }),
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };
    const legacyEntry = makeEntry({
      targetCats: undefined,
      mergedMessageIds: undefined,
      queuedNotifiedByCatIds: undefined,
      allTargetCats: undefined,
    });

    await emitQueueUpdated(socketManager, 'u1', 't1', [legacyEntry], messageStore, 'enriched');

    assert.deepEqual(emitted[0].queue[0].messagePreview, {
      contentBlocks: [{ kind: 'text', text: 'preview text' }],
      replyTo: 'msg-parent',
    });
    assert.deepEqual(emitted[0].queue[0].targetStates, {});
  });

  it('publishes message-bound terminal receipts after withdrawal empties the Queue', async () => {
    const emitted = [];
    const terminalCustody = makeWithdrawnCustody();
    const messageStore = {
      getById: async (messageId) =>
        messageId === 'msg-withdrawn' ? { id: messageId, queueCustody: terminalCustody } : null,
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };

    await emitQueueUpdated(socketManager, 'u1', 't1', [], messageStore, 'removed', {
      receiptMessageIds: ['msg-withdrawn', 'msg-withdrawn', 'msg-missing'],
    });

    assert.deepEqual(emitted, [
      {
        threadId: 't1',
        queue: [],
        action: 'removed',
        messageReceipts: [
          {
            messageId: 'msg-withdrawn',
            queueReceipt: {
              version: 1,
              entryId: 'withdrawn-entry',
              targets: [{ catId: 'opus', state: 'withdrawn', withdrawnAt: 20 }],
              reminderAttempts: [],
            },
          },
        ],
      },
    ]);
  });

  it('does not poison a same-scope successor when the previous emitter throws', async () => {
    const emitted = [];
    let failFirst = true;
    const socketManager = {
      emitToUser: (_userId, _event, data) => {
        if (failFirst) {
          failFirst = false;
          throw new Error('synthetic emit failure');
        }
        emitted.push(data.action);
      },
    };

    const failed = emitQueueUpdated(socketManager, 'u1', 't1', [], null, 'first');
    const following = emitQueueUpdated(socketManager, 'u1', 't1', [], null, 'second');

    await assert.rejects(failed, /synthetic emit failure/);
    await following;
    assert.deepEqual(emitted, ['second']);
  });
});
