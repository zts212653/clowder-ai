/**
 * F220 intake — ordered, frozen, bounded Queue publication.
 *
 * The public Queue projection contains pending source rows only. Delivery and
 * terminal truth belongs to History lifecycle dispatchRefs/response messages.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { emitQueueUpdated, projectPublicQueueEntry } = await import('../dist/utils/queue-enrichment.js');

describe('F220 intake: queue snapshot publication ordering', () => {
  const makeEntry = (overrides = {}) => ({
    version: 2,
    id: 'queue-entry',
    threadId: 't1',
    owner: { kind: 'user', userId: 'u1' },
    kind: 'conversation_input',
    from: { kind: 'user', userId: 'user-1' },
    targets: ['opus'],
    payload: { sourceRecordId: 'msg-entry', content: 'queued work', messageId: 'msg-entry' },
    execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
    delivery: {},
    status: 'queued',
    enqueuedAt: 1,
    priority: 'normal',
    ...overrides,
  });

  it('never publishes private system input content', async () => {
    const emitted = [];
    await emitQueueUpdated(
      { emitToUser: (_userId, _event, data) => emitted.push(data) },
      'u1',
      't1',
      [
        makeEntry({
          kind: 'private_input',
          from: { kind: 'system', service: 'podcast' },
          payload: { sourceRecordId: 'private-prompt', content: 'secret podcast prompt' },
        }),
      ],
      null,
      'private',
    );
    assert.deepEqual(emitted[0].queue, []);
  });

  it('projects one pending source row without Queue-owned processing or terminal state', () => {
    const projected = projectPublicQueueEntry(
      makeEntry({
        targets: ['opus', 'codex'],
        delivery: {
          authorIntentByTarget: {
            opus: {
              requested: 'continue_current',
              fallbackAt: 12,
              fallbackReason: 'no_active_parent',
            },
            removed: { requested: 'next_work' },
          },
          reminderAttempts: [
            {
              id: 'reminder-opus',
              targetCatId: 'opus',
              invocationId: 'inv-opus',
              state: 'requested',
              requestedAt: 10,
            },
            {
              id: 'reminder-removed',
              targetCatId: 'removed',
              invocationId: 'inv-removed',
              state: 'requested',
              requestedAt: 11,
            },
          ],
        },
      }),
    );

    assert.deepEqual(projected.targetCats, ['opus', 'codex']);
    assert.equal(projected.status, 'queued');
    assert.equal(projected.authorIntentByTarget.opus.effective, 'next_work');
    assert.deepEqual(
      projected.reminderAttempts.map((attempt) => attempt.id),
      ['reminder-opus'],
    );
    assert.equal('queueReceipt' in projected, false);
    assert.equal('targetStates' in projected, false);
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
        return null;
      },
    };
    const socketManager = {
      emitToUser: (userId, _event, data) => emitted.push({ userId, ...data }),
    };

    const older = emitQueueUpdated(
      socketManager,
      'u1',
      't1',
      [makeEntry({ payload: { sourceRecordId: 'msg-older', content: 'older', messageId: 'msg-older' } })],
      messageStore,
      'older',
    );
    await olderStartedPromise;
    const newer = emitQueueUpdated(socketManager, 'u1', 't1', [], messageStore, 'newer');
    const independent = emitQueueUpdated(socketManager, 'u2', 't1', [], messageStore, 'independent');

    try {
      await independent;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        emitted.filter((event) => event.userId === 'u1'),
        [],
      );
      assert.deepEqual(
        emitted.filter((event) => event.userId === 'u2').map((event) => event.action),
        ['independent'],
      );
    } finally {
      releaseOlder?.();
      await Promise.allSettled([older, newer, independent]);
    }

    assert.deepEqual(
      emitted.filter((event) => event.userId === 'u1').map((event) => event.action),
      ['older', 'newer'],
    );
    assert.equal(
      emitted.some((event) => 'messageReceipts' in event),
      false,
    );
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
    const entry = makeEntry();
    const publication = emitQueueUpdated(
      { emitToUser: (_userId, _event, data) => emitted.push(data) },
      'u1',
      't1',
      [entry],
      messageStore,
      'frozen',
    );
    await lookupStartedPromise;
    entry.targets = ['codex'];
    releaseLookup();
    await publication;

    assert.deepEqual(emitted[0].queue[0].targetCats, ['opus']);
  });

  it('releases the publication tail with the pending projection after the enrichment deadline', async (t) => {
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
    const socketManager = { emitToUser: (_userId, _event, data) => emitted.push(data) };

    const stalled = emitQueueUpdated(socketManager, 'u1', 't1', [makeEntry()], messageStore, 'stalled');
    await lookupStartedPromise;
    const following = emitQueueUpdated(socketManager, 'u1', 't1', [], messageStore, 'following');
    t.mock.timers.tick(2_000);
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([stalled, following]);

    assert.deepEqual(
      emitted.map((event) => ({ action: event.action, targetCats: event.queue[0]?.targetCats })),
      [
        { action: 'stalled', targetCats: ['opus'] },
        { action: 'following', targetCats: undefined },
      ],
    );
  });

  it('enriches a targetless pending source row without inventing a delivery target', async () => {
    const emitted = [];
    const messageStore = {
      getById: async (id) => ({
        id,
        userId: 'u1',
        threadId: 't1',
        contentBlocks: [{ kind: 'text', text: 'preview text' }],
        replyTo: 'msg-parent',
      }),
    };

    await emitQueueUpdated(
      { emitToUser: (_userId, _event, data) => emitted.push(data) },
      'u1',
      't1',
      [makeEntry({ targets: [] })],
      messageStore,
      'enriched',
    );

    assert.deepEqual(emitted[0].queue[0].messagePreview, {
      contentBlocks: [{ kind: 'text', text: 'preview text' }],
      replyTo: 'msg-parent',
    });
    assert.deepEqual(emitted[0].queue[0].targetCats, []);
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
