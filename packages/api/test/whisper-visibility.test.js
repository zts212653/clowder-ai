/**
 * F35: Whisper Visibility Tests
 * Tests for canViewMessage, whisper storage, reveal, and callback filtering.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

describe('canViewMessage', () => {
  let canViewMessage;

  beforeEach(async () => {
    ({ canViewMessage } = await import('../dist/domains/cats/services/stores/visibility.js'));
  });

  test('user always sees everything', () => {
    const viewer = { type: 'user' };
    const publicMsg = { visibility: 'public' };
    const whisperMsg = { visibility: 'whisper', whisperTo: ['codex'] };
    const unrevealedWhisper = { visibility: 'whisper', whisperTo: ['gemini'] };

    assert.equal(canViewMessage(publicMsg, viewer), true);
    assert.equal(canViewMessage(whisperMsg, viewer), true);
    assert.equal(canViewMessage(unrevealedWhisper, viewer), true);
  });

  test('public messages visible to all cats', () => {
    const viewer = { type: 'cat', catId: 'opus' };
    assert.equal(canViewMessage({ visibility: 'public' }, viewer), true);
    assert.equal(canViewMessage({}, viewer), true); // undefined = public
  });

  test('whisper visible only to recipients', () => {
    const whisper = { visibility: 'whisper', whisperTo: ['opus', 'gemini'] };
    assert.equal(canViewMessage(whisper, { type: 'cat', catId: 'opus' }), true);
    assert.equal(canViewMessage(whisper, { type: 'cat', catId: 'gemini' }), true);
    assert.equal(canViewMessage(whisper, { type: 'cat', catId: 'codex' }), false);
  });

  test('revealed whisper visible to all', () => {
    const revealed = { visibility: 'whisper', whisperTo: ['opus'], revealedAt: Date.now() };
    assert.equal(canViewMessage(revealed, { type: 'cat', catId: 'opus' }), true);
    assert.equal(canViewMessage(revealed, { type: 'cat', catId: 'codex' }), true);
  });

  test('whisper with empty whisperTo is invisible to all cats', () => {
    const whisper = { visibility: 'whisper' }; // no whisperTo
    assert.equal(canViewMessage(whisper, { type: 'cat', catId: 'opus' }), false);
  });
});

describe('MessageStore whisper', () => {
  let MessageStore;
  let store;

  beforeEach(async () => {
    ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
    store = new MessageStore();
  });

  test('append stores visibility and whisperTo', () => {
    const msg = store.append({
      userId: 'user1',
      catId: null,
      content: 'secret message',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread1',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });

    assert.equal(msg.visibility, 'whisper');
    assert.deepEqual(msg.whisperTo, ['opus']);
  });

  test('revealWhispers sets revealedAt on all whispers in thread', () => {
    store.append({
      userId: 'user1',
      catId: null,
      content: 'public msg',
      mentions: [],
      timestamp: 1000,
      threadId: 'thread1',
    });
    store.append({
      userId: 'user1',
      catId: null,
      content: 'whisper 1',
      mentions: ['opus'],
      timestamp: 2000,
      threadId: 'thread1',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    store.append({
      userId: 'user1',
      catId: null,
      content: 'whisper 2',
      mentions: ['codex'],
      timestamp: 3000,
      threadId: 'thread1',
      visibility: 'whisper',
      whisperTo: ['codex'],
    });
    store.append({
      userId: 'user1',
      catId: null,
      content: 'other thread whisper',
      mentions: ['opus'],
      timestamp: 4000,
      threadId: 'thread2',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });

    const count = store.revealWhispers('thread1', 'user1');
    assert.equal(count, 2);

    // Verify thread1 whispers are revealed
    const thread1 = store.getByThread('thread1', 10, 'user1');
    const whispers = thread1.filter((m) => m.visibility === 'whisper');
    assert.equal(whispers.length, 2);
    for (const w of whispers) {
      assert.ok(w.revealedAt, 'whisper should have revealedAt');
    }

    // Verify thread2 whisper is NOT revealed
    const thread2 = store.getByThread('thread2', 10, 'user1');
    const t2Whispers = thread2.filter((m) => m.visibility === 'whisper');
    assert.equal(t2Whispers.length, 1);
    assert.equal(t2Whispers[0].revealedAt, undefined);
  });

  test('revealWhispers is idempotent', () => {
    store.append({
      userId: 'user1',
      catId: null,
      content: 'whisper',
      mentions: ['opus'],
      timestamp: 1000,
      threadId: 'thread1',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });

    assert.equal(store.revealWhispers('thread1', 'user1'), 1);
    assert.equal(store.revealWhispers('thread1', 'user1'), 0); // already revealed
  });
});

describe('sendMessageSchema whisper validation', () => {
  let sendMessageSchema;

  beforeEach(async () => {
    ({ sendMessageSchema } = await import('../dist/routes/messages.schema.js'));
  });

  test('valid whisper message', () => {
    const result = sendMessageSchema.safeParse({
      content: 'secret',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    assert.ok(result.success, `should pass: ${JSON.stringify(result.error?.issues)}`);
  });

  test('whisper without whisperTo is rejected', () => {
    const result = sendMessageSchema.safeParse({
      content: 'secret',
      visibility: 'whisper',
    });
    assert.equal(result.success, false);
  });

  test('whisper with empty whisperTo is rejected', () => {
    const result = sendMessageSchema.safeParse({
      content: 'secret',
      visibility: 'whisper',
      whisperTo: [],
    });
    assert.equal(result.success, false);
  });

  test('public message ignores whisperTo', () => {
    const result = sendMessageSchema.safeParse({
      content: 'hello',
      visibility: 'public',
      whisperTo: ['opus'],
    });
    assert.ok(result.success);
  });

  test('default visibility (no field) is accepted', () => {
    const result = sendMessageSchema.safeParse({
      content: 'hello',
    });
    assert.ok(result.success);
  });

  test('accepts long text up to 100K characters', () => {
    const longContent = 'x'.repeat(50000);
    const result = sendMessageSchema.safeParse({ content: longContent });
    assert.ok(result.success, `50K text should be accepted: ${JSON.stringify(result.error?.issues)}`);
  });

  test('rejects text exceeding 100K characters', () => {
    const tooLong = 'x'.repeat(100001);
    const result = sendMessageSchema.safeParse({ content: tooLong });
    assert.equal(result.success, false, 'text over 100K should be rejected');
  });
});
