/**
 * F122: pushToWorklist returns structured PushResult (AC-A2)
 * Split from worklist-registry.test.js to stay within 350-line file cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('WorklistRegistry: PushResult structured reason (F122)', () => {
  test('not_found reason when no worklist registered', async () => {
    const { pushToWorklist } = await import('../dist/domains/cats/services/agents/routing/WorklistRegistry.js');
    const result = pushToWorklist('nonexistent-thread-f122', ['opus']);
    assert.deepEqual(result.added, []);
    assert.equal(result.reason, 'not_found');
  });

  test('depth_limit reason when maxDepth exceeded', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );
    const threadId = 'test-f122-depth';
    const entry = registerWorklist(threadId, ['opus'], 0); // maxDepth=0
    try {
      const result = pushToWorklist(threadId, ['codex']);
      assert.deepEqual(result.added, []);
      assert.equal(result.reason, 'depth_limit');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('caller_mismatch reason when caller is not current cat', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );
    const threadId = 'test-f122-caller';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const result = pushToWorklist(threadId, ['codex'], 'gemini'); // gemini != opus
      assert.deepEqual(result.added, []);
      assert.equal(result.reason, 'caller_mismatch');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('all_duplicate reason when all cats already pending', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );
    const threadId = 'test-f122-dup';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const result = pushToWorklist(threadId, ['opus']); // already in list
      assert.deepEqual(result.added, []);
      assert.equal(result.reason, 'all_duplicate');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('success has no reason', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );
    const threadId = 'test-f122-success';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const result = pushToWorklist(threadId, ['codex']);
      assert.deepEqual(result.added, ['codex']);
      assert.equal(result.reason, undefined);
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });
});
