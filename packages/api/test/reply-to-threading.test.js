/**
 * F121: replyTo threading — persist, validate, hydrate preview
 * RED → GREEN → REFACTOR
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('replyTo threading', () => {
  // ── StoredMessage persistence ──

  test('append() persists replyTo field', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const parent = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Original message',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const reply = store.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'Reply to original',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-1',
      replyTo: parent.id,
    });

    assert.equal(reply.replyTo, parent.id);
    const fetched = store.getById(reply.id);
    assert.equal(fetched?.replyTo, parent.id);
  });

  test('append() without replyTo leaves field undefined', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const msg = store.append({
      userId: 'user-1',
      catId: null,
      content: 'No reply',
      mentions: [],
      timestamp: 1000,
    });

    assert.equal(msg.replyTo, undefined);
  });

  test('getByThread returns messages with replyTo intact', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();

    const parent = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Parent',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    store.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'Child',
      mentions: [],
      timestamp: 2000,
      threadId: 'thread-1',
      replyTo: parent.id,
    });

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

    const parent = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: '这是一条很长的消息，需要被截断到八十个字符以内来显示预览内容，确保在引用气泡中不会太长影响阅读体验',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

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

    const parent = store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Will be deleted',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

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

    const parent = store.append({
      userId: 'user-1',
      catId: null,
      content: 'User message',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread-1',
    });

    const preview = await hydrateReplyPreview(store, parent.id);
    assert.ok(preview);
    assert.equal(preview.senderCatId, null);
    assert.equal(preview.content, 'User message');
  });
});
