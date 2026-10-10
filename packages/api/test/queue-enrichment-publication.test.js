/**
 * F220 intake — immediate, frozen Queue publication.
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
        },
      }),
    );

    assert.deepEqual(projected.targetCats, ['opus', 'codex']);
    assert.equal(projected.status, 'queued');
    assert.equal(projected.authorIntentByTarget.opus.effective, 'next_work');
    assert.equal('queueReceipt' in projected, false);
    assert.equal('targetStates' in projected, false);
  });

  it('publishes pending targets and retirement without waiting for any History preview', async () => {
    const emitted = [];
    let lookups = 0;
    let releasePreview;
    const messageStore = {
      getById: async () => {
        lookups++;
        return new Promise((resolve) => {
          releasePreview = resolve;
        });
      },
    };
    const socketManager = { emitToUser: (userId, _event, data) => emitted.push({ userId, ...data }) };
    const { enrichQueueEntries } = await import('../dist/utils/queue-enrichment.js');
    const preview = enrichQueueEntries([makeEntry()], messageStore);
    const started = performance.now();
    const queued = emitQueueUpdated(socketManager, 'u1', 't1', [makeEntry()], 'enqueued');
    const delivered = emitQueueUpdated(socketManager, 'u1', 't1', [], 'processing');
    const independent = emitQueueUpdated(socketManager, 'u2', 't1', [makeEntry()], 'enqueued');
    // Assert before releasing a lookup or advancing any timer.
    try {
      assert.deepEqual(
        emitted.map((e) => [e.userId, e.action, e.queue.length]),
        [
          ['u1', 'enqueued', 1],
          ['u1', 'processing', 0],
          ['u2', 'enqueued', 1],
        ],
      );
      await Promise.all([queued, delivered, independent]);
      assert.equal(lookups, 1, 'the stalled HTTP preview does not hold any mutation publication');
    } finally {
      releasePreview(null);
      await preview;
    }
    console.log(
      JSON.stringify({ scenario: 'blocked-preview-publication', elapsedMs: performance.now() - started, lookups }),
    );
  });

  it('freezes mutable queue entries at publication call time', async () => {
    const emitted = [];
    const entry = makeEntry();
    const publication = emitQueueUpdated(
      { emitToUser: (_userId, _event, data) => emitted.push(data) },
      'u1',
      't1',
      [entry],
      'frozen',
    );
    entry.targets[0] = 'codex';
    entry.from.userId = 'changed';
    await publication;
    assert.deepEqual(emitted[0].queue[0].targetCats, ['opus']);
    assert.deepEqual(emitted[0].queue[0].from, { kind: 'user', userId: 'user-1' });
  });

  it('retains rich connector/reply previews in the HTTP projection without inventing a target', async () => {
    const { enrichQueueEntries } = await import('../dist/utils/queue-enrichment.js');
    const queue = await enrichQueueEntries([makeEntry({ targets: [] })], {
      getById: async (id) => ({
        id,
        contentBlocks: [{ kind: 'text', text: 'preview text' }],
        replyTo: 'msg-parent',
        source: { connector: 'content-review' },
      }),
    });
    assert.deepEqual(queue[0].messagePreview, {
      contentBlocks: [{ kind: 'text', text: 'preview text' }],
      replyTo: 'msg-parent',
      connector: 'content-review',
      source: { connector: 'content-review' },
    });
    assert.deepEqual(queue[0].targetCats, []);
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

    const failed = emitQueueUpdated(socketManager, 'u1', 't1', [], 'first');
    const following = emitQueueUpdated(socketManager, 'u1', 't1', [], 'second');
    await assert.rejects(failed, /synthetic emit failure/);
    await following;
    assert.deepEqual(emitted, ['second']);
  });
});
