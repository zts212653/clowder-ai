/**
 * F335 交付三 — the desk hears a reply when it becomes a complete message.
 *
 * THE GAP (real desktop, 11-04). A cat calls publish-reference and then cat_cafe_bring_to_desk in
 * one turn. The reply is admitted as a processing placeholder; the work card waits in the rich-block
 * buffer and lands when the turn's terminal commit writes the final body. That terminal commit does
 * not go through `append`, so a desk that only listened to appends never heard that the card had
 * landed, and the brought work waited until the person next came back.
 *
 * The publishing seam is the one place every complete message passes (plain appends and both
 * terminal commits); processing placeholders, whispers and plugin messages never publish.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createPublishingMessageStore;
let createMessagingStores;
let MessageStore;

const THREAD = 'thread-video';
const CARD = {
  id: 'work-reference-abc',
  kind: 'card',
  v: 1,
  title: '六猫岛 · 单采肖像参考',
  bodyMarkdown: '',
  meta: { kind: 'work_reference', reference: { contentRef: 'work:sheet', ownerRevision: 1 } },
};

let published;
let store;

beforeEach(async () => {
  ({ createPublishingMessageStore } = await import('../dist/domains/messaging/publishing-message-store.js'));
  ({ createMessagingStores } = await import('../dist/domains/messaging/stores/factory.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  const stores = createMessagingStores();
  published = [];
  store = createPublishingMessageStore(new MessageStore(), {
    events: stores.events,
    publications: stores.publications,
    onMessagePublished: (message) => published.push(message),
    onPublishFailure: (error) => {
      throw error;
    },
  });
});

describe('F335 desk — a complete reply is heard, with its cards', () => {
  test('the processing placeholder is silent; the terminal commit is heard with the card that landed', async () => {
    const placeholder = await store.append({
      userId: 'owner',
      threadId: THREAD,
      from: { kind: 'agent', catId: 'codex61-sol' },
      content: '',
      mentions: [],
      timestamp: 100,
      lifecycle: {
        kind: 'response',
        orderKey: '100:sol',
        invocationId: 'inv-sol',
        targetId: 'codex61-sol',
        inputEntryIds: ['entry-1'],
        inputMessageIds: ['msg-operator'],
        status: 'processing',
        startedAt: 100,
      },
    });
    assert.deepEqual(published, [], 'a placeholder is not a complete reply');

    await store.commitLifecycleResponseTerminal(placeholder.id, {
      invocationId: 'inv-sol',
      status: 'completed',
      completedAt: 200,
      content: '带好了',
      mentions: [],
      extra: { rich: { v: 1, blocks: [CARD] } },
    });
    assert.equal(published.length, 1);
    assert.equal(published[0].id, placeholder.id);
    assert.deepEqual(published[0].extra?.rich?.blocks, [CARD], 'the desk sees the card that just landed');

    await store.commitLifecycleResponseTerminal(placeholder.id, {
      invocationId: 'inv-sol',
      status: 'completed',
      completedAt: 200,
      content: '带好了',
      mentions: [],
      extra: { rich: { v: 1, blocks: [CARD] } },
    });
    // A replay republishes under the same deterministic event key (it repairs a failed publish), so an
    // observer may hear the same message again; the desk's nudge is idempotent.
    assert.deepEqual(
      published.map((m) => m.id),
      [placeholder.id, placeholder.id],
    );
  });

  test('a plain complete append is heard; a whisper is not', async () => {
    await store.append({
      userId: 'owner',
      threadId: THREAD,
      from: { kind: 'agent', catId: 'opus55' },
      content: '看这个',
      mentions: [],
      timestamp: 300,
      extra: { rich: { v: 1, blocks: [CARD] } },
    });
    await store.append({
      userId: 'owner',
      threadId: THREAD,
      from: { kind: 'agent', catId: 'opus55' },
      content: '悄悄话',
      mentions: [],
      timestamp: 301,
      visibility: 'whisper',
      whisperTo: ['codex61-sol'],
    });
    assert.deepEqual(
      published.map((m) => m.content),
      ['看这个'],
    );
  });
});
