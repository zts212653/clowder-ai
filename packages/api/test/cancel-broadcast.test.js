/**
 * Cancel broadcast integration test
 * Verifies that cancel_invocation produces correct catId-aware broadcasts.
 *
 * Tests the REAL production buildCancelMessages function (not a copy).
 * - Single system_info message (no "cancel chorus")
 * - Per-cat done messages to clear each cat's loading state
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { buildCancelMessages } = await import('../dist/infrastructure/websocket/SocketManager.js');

describe('buildCancelMessages (production function)', () => {
  test('single cat cancel: 1 system_info + 1 done with correct catId', () => {
    const tracker = new InvocationTracker();
    // start(threadId, catId, userId, catIds)
    tracker.start('t1', 'gemini', 'user1', ['gemini']);
    const result = tracker.cancel('t1', 'gemini', 'user1');
    const messages = buildCancelMessages(result);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'system_info');
    assert.equal(messages[0].catId, 'gemini');
    assert.equal(messages[1].type, 'done');
    assert.equal(messages[1].catId, 'gemini');
    assert.equal(messages[1].isFinal, true);
  });

  test('multi-cat cancel: 1 system_info + N done (no cancel chorus)', () => {
    const tracker = new InvocationTracker();
    // start(threadId, catId, userId, catIds) — primary cat is opus
    tracker.start('t1', 'opus', 'user1', ['opus', 'codex', 'gemini']);
    const result = tracker.cancel('t1', 'opus', 'user1');
    const messages = buildCancelMessages(result);

    // 1 system_info + 3 done = 4 total
    assert.equal(messages.length, 4);

    // Only one system_info (not three!)
    const systemInfos = messages.filter((m) => m.type === 'system_info');
    assert.equal(systemInfos.length, 1);
    assert.equal(systemInfos[0].catId, 'opus');

    // Three done messages, one per cat
    const dones = messages.filter((m) => m.type === 'done');
    assert.equal(dones.length, 3);
    assert.deepEqual(
      dones.map((d) => d.catId),
      ['opus', 'codex', 'gemini'],
    );
    assert.ok(dones.every((d) => d.isFinal === true));
  });

  test('empty catIds fallback: defaults to opus', () => {
    const tracker = new InvocationTracker();
    // start(threadId, catId, userId) — no catIds
    tracker.start('t1', 'opus', 'user1');
    const result = tracker.cancel('t1', 'opus', 'user1');
    const messages = buildCancelMessages(result);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].catId, 'opus');
    assert.equal(messages[1].catId, 'opus');
  });

  test('failed cancel: no messages', () => {
    const result = { cancelled: false, catIds: [] };
    const messages = buildCancelMessages(result);
    assert.equal(messages.length, 0);
  });

  test('cancelled with unknown catId still produces messages (F32-a: any string is valid catId)', () => {
    // F32-a: createCatId accepts any non-empty string, so unknown catId no longer throws
    const result = { cancelled: true, catIds: ['unknown-cat'] };
    const messages = buildCancelMessages(result);
    assert.equal(messages.length, 2); // system + done
    assert.equal(messages[0].catId, 'unknown-cat');
  });
});
