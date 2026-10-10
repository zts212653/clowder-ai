/**
 * F121: replyTo threading — persist, validate, hydrate preview
 * RED → GREEN → REFACTOR
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

describe('replyTo threading', () => {
  test('reply and Queue preview preserve canonical sender identity and display metadata', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const { enrichQueueEntries, emitQueueUpdated } = await import('../dist/utils/queue-enrichment.js');
    const { connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js');
    const identities = [
      { kind: 'external', connectorId: 'github-wait' },
      { kind: 'external', connectorId: 'custom', sender: { id: 'actor', name: 'Alice' } },
      { kind: 'plugin', instanceId: 'plugin-instance' },
      { kind: 'system', service: 'system-service' },
      { kind: 'user', userId: 'user-1' },
      { kind: 'agent', catId: 'opus' },
    ];
    for (const from of identities) {
      const store = new MessageStore();
      const source =
        from.kind === 'external' || from.kind === 'system'
          ? {
              connector: from.kind === 'external' ? from.connectorId : 'custom',
              label: 'Display Room',
              icon: '🧩',
            }
          : undefined;
      const connector = connectorDeliveryHarness({ messageStore: store });
      let parentId;
      if (source) {
        const result = await connector.delivery.deliver({
          ownerUserId: 'user-1',
          threadId: 'thread-1',
          targetCatId: 'opus',
          content: 'content',
          from,
          source,
          idempotencyKey: 'key',
        });
        assert.equal(result.state, 'started');
        const [entry] = connector.admitted('thread-1', 'user-1');
        parentId = entry.payload.messageId;
        const [enriched] = await enrichQueueEntries([entry], store);
        assert.deepEqual(enriched.from, from);
        assert.deepEqual(enriched.messagePreview.source, source);
        // The immediate event never joins History; a blocked preview cannot delay dispatch publication.
        const emitted = [];
        await emitQueueUpdated(
          { emitToUser: (...args) => emitted.push(args) },
          'user-1',
          'thread-1',
          [entry],
          'enqueue',
        );
        assert.deepEqual(emitted[0][2].queue[0].from, from);
      } else {
        parentId = store.append({
          from,
          userId: 'user-1',
          threadId: 'thread-1',
          content: 'content',
          mentions: [],
          timestamp: 1,
          ...(from.kind === 'plugin'
            ? {
                extra: {
                  pluginMessage: {
                    instanceId: from.instanceId,
                    revision: 1,
                    provenance: { origin: from, epistemicStatus: 'inference' },
                    elements: [],
                  },
                },
              }
            : {}),
        }).id;
      }
      const preview = await hydrateReplyPreview(store, parentId);
      assert.deepEqual(preview.from, from);
      assert.deepEqual(preview.source, source);
      store.softDelete(parentId, 'user-1');
      const deleted = await hydrateReplyPreview(store, parentId);
      assert.equal(deleted.deleted, true);
      assert.deepEqual(deleted.from, from);
      assert.equal(deleted.source, undefined);
    }
  });
  // ── StoredMessage persistence ──

  test('append() persists replyTo field', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const parent = store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: 'opus',
        content: 'Original message',
        mentions: [],
        timestamp: 1000,
        threadId: 'thread-1',
      }),
    );

    const reply = store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: 'codex',
        content: 'Reply to original',
        mentions: [],
        timestamp: 2000,
        threadId: 'thread-1',
        replyTo: parent.id,
      }),
    );

    assert.equal(reply.replyTo, parent.id);
    const fetched = store.getById(reply.id);
    assert.equal(fetched?.replyTo, parent.id);
  });

  test('append() without replyTo leaves field undefined', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const msg = store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        content: 'No reply',
        mentions: [],
        timestamp: 1000,
      }),
    );

    assert.equal(msg.replyTo, undefined);
  });

  test('getByThread returns messages with replyTo intact', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const parent = store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: 'opus',
        content: 'Parent',
        mentions: [],
        timestamp: 1000,
        threadId: 'thread-1',
      }),
    );

    store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: 'codex',
        content: 'Child',
        mentions: [],
        timestamp: 2000,
        threadId: 'thread-1',
        replyTo: parent.id,
      }),
    );

    const messages = store.getByThread('thread-1');
    const child = messages.find((m) => m.content === 'Child');
    assert.equal(child?.replyTo, parent.id);
  });

  // ── replyPreview hydration helper ──

  test('hydrateReplyPreview returns sender + truncated content for existing parent', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const parent = store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: 'opus',
        content: '这是一条很长的消息，需要被截断到八十个字符以内来显示预览内容，确保在引用气泡中不会太长影响阅读体验',
        mentions: [],
        timestamp: 1000,
        threadId: 'thread-1',
      }),
    );

    const preview = await hydrateReplyPreview(store, parent.id);
    assert.ok(preview);
    assert.equal(preview.senderCatId, 'opus');
    assert.ok(preview.content.length <= 80);
    assert.equal(preview.deleted, undefined);
  });

  test('hydrateReplyPreview returns deleted preview for soft-deleted parent', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const parent = store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: 'opus',
        content: 'Will be deleted',
        mentions: [],
        timestamp: 1000,
        threadId: 'thread-1',
      }),
    );

    store.softDelete(parent.id, 'user-1');

    const preview = await hydrateReplyPreview(store, parent.id);
    assert.ok(preview);
    assert.equal(preview.deleted, true);
    assert.equal(preview.content, '');
  });

  test('hydrateReplyPreview returns null for nonexistent parent', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const preview = await hydrateReplyPreview(store, 'nonexistent-id');
    assert.equal(preview, null);
  });

  test('hydrateReplyPreview returns null senderCatId for user messages', async () => {
    const { MessageStore, hydrateReplyPreview } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();

    const parent = store.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        content: 'User message',
        mentions: [],
        timestamp: 1000,
        threadId: 'thread-1',
      }),
    );

    const preview = await hydrateReplyPreview(store, parent.id);
    assert.ok(preview);
    assert.equal(preview.senderCatId, null);
    assert.equal(preview.content, 'User message');
  });
});
