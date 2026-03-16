/**
 * F121: WorklistRegistry a2aTriggerMessageId tests
 * Split from worklist-registry.test.js to stay under 350-line cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('WorklistRegistry: a2aTriggerMessageId (F121)', () => {
  test('a2aTriggerMessageId tracks trigger message through pushToWorklist', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'test-trigger-msg';
    const entry = registerWorklist(threadId, ['opus'], 10);

    try {
      // 1. First push: opus @mentions codex with msg-A
      const push1 = pushToWorklist(threadId, ['codex'], 'opus', undefined, 'msg-A');
      assert.deepEqual(push1.added, ['codex']);
      assert.equal(entry.a2aTriggerMessageId.get('codex'), 'msg-A');
      assert.equal(entry.a2aFrom.get('codex'), 'opus');

      // 2. Advance to codex executing, then codex @mentions sonnet with msg-B
      entry.executedIndex = 1;
      const push2 = pushToWorklist(threadId, ['sonnet'], 'codex', undefined, 'msg-B');
      assert.deepEqual(push2.added, ['sonnet']);
      assert.equal(entry.a2aTriggerMessageId.get('sonnet'), 'msg-B');

      // 3. Duplicate re-enqueue: codex @mentions sonnet AGAIN with msg-C
      //    sonnet is already pending (non-original) → should update to latest
      const push3 = pushToWorklist(threadId, ['sonnet'], 'codex', undefined, 'msg-C');
      assert.deepEqual(push3.added, []);
      assert.equal(
        entry.a2aTriggerMessageId.get('sonnet'),
        'msg-C',
        'Duplicate re-enqueue must update triggerMessageId to latest',
      );
      assert.equal(entry.a2aFrom.get('sonnet'), 'codex');

      // 4. Re-mention A2A-added pending target with new message
      entry.executedIndex = 0;
      pushToWorklist(threadId, ['codex'], 'opus', undefined, 'msg-D');
      // codex was A2A-added (not original) → should update
      assert.equal(
        entry.a2aTriggerMessageId.get('codex'),
        'msg-D',
        'A2A-added pending target should update triggerMessageId on re-mention',
      );
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('response-text path: direct a2aTriggerMessageId.set on worklist entry', async () => {
    // This mirrors what route-serial.ts does for response-text @mentions:
    // it directly sets a2aTriggerMessageId on the entry (not via pushToWorklist).
    const { registerWorklist, unregisterWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'test-response-text-trigger';
    const entry = registerWorklist(threadId, ['opus', 'codex'], 10);

    try {
      // Simulate: opus runs, its stored message has id 'opus-msg-1',
      // and its response text contains @codex.
      // route-serial directly sets the trigger message on the entry.
      const storedMsgId = 'opus-msg-1';
      entry.a2aTriggerMessageId.set('codex', storedMsgId);
      entry.a2aFrom.set('codex', 'opus');

      assert.equal(entry.a2aTriggerMessageId.get('codex'), 'opus-msg-1');
      assert.equal(entry.a2aFrom.get('codex'), 'opus');

      // Simulate: opus also @mentions sonnet (new cat, pushed to worklist)
      entry.a2aTriggerMessageId.set('sonnet', storedMsgId);
      entry.a2aFrom.set('sonnet', 'opus');
      assert.equal(entry.a2aTriggerMessageId.get('sonnet'), 'opus-msg-1');

      // Original target (opus) should NOT have a trigger message
      assert.equal(entry.a2aTriggerMessageId.get('opus'), undefined);
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('original pending target does NOT get triggerMessageId overwritten', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const threadId = 'test-trigger-msg-original';
    // Both opus and codex are original targets
    const entry = registerWorklist(threadId, ['opus', 'codex'], 10);

    try {
      // opus @mentions codex (codex is original pending) → should NOT set triggerMessageId
      const push = pushToWorklist(threadId, ['codex'], 'opus', undefined, 'msg-X');
      assert.deepEqual(push.added, []);
      assert.equal(
        entry.a2aTriggerMessageId.get('codex'),
        undefined,
        'Original pending target must NOT get triggerMessageId from re-mention',
      );
      assert.equal(entry.a2aFrom.get('codex'), undefined, 'Original pending target keeps no a2aFrom');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });
});
