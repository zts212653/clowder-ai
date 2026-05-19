/**
 * F193 AC-B4 boundary regression: hydrateCrossThreadReplyHint helper
 *
 * Locks 3 boundary cases that future refactors might erode:
 *  1. Trigger message NOT FOUND → null (don't crash, no hint)
 *  2. Trigger has NO crossPost metadata (same-thread post) → null
 *     (KD-1 boundary: agent-key target-thread writes also have no crossPost,
 *      so this case covers both)
 *  3. Trigger has NO catId (user-authored message) → null
 *
 * Positive case: trigger has both crossPost.sourceThreadId + catId →
 * structured { sourceThreadId, senderCatId } returned.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F193 AC-B4: hydrateCrossThreadReplyHint boundary', () => {
  test('trigger message not found → null', async () => {
    const { hydrateCrossThreadReplyHint } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = { getById: async () => null };
    const result = await hydrateCrossThreadReplyHint(store, 'nonexistent-id');
    assert.equal(result, null);
  });

  test('same-thread post (no extra.crossPost) → null', async () => {
    const { hydrateCrossThreadReplyHint } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = {
      getById: async () => ({
        id: 'msg-1',
        threadId: 'same-thread',
        userId: 'user-1',
        catId: 'codex',
        content: 'just a status update',
        mentions: [],
        timestamp: Date.now(),
        // NO extra.crossPost — same-thread post / agent-key target-thread write
      }),
    };
    const result = await hydrateCrossThreadReplyHint(store, 'msg-1');
    assert.equal(result, null, 'same-thread / agent-key target-thread → no hint');
  });

  test('user-authored message (catId null) → null', async () => {
    const { hydrateCrossThreadReplyHint } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = {
      getById: async () => ({
        id: 'user-msg',
        threadId: 'thread-x',
        userId: 'user-1',
        catId: null, // user message
        content: '@codex hi',
        mentions: ['codex'],
        timestamp: Date.now(),
        extra: {
          crossPost: { sourceThreadId: 'thread-source' },
        },
      }),
    };
    const result = await hydrateCrossThreadReplyHint(store, 'user-msg');
    assert.equal(result, null, 'user-authored cross-post → no hint (relay is cat→cat only)');
  });

  test('codex P1 (2026-05-08): queue-path fallback — empty worklist map + currentUserMessageId still hydrates hint', async () => {
    // Closes Codex review P1: modern InvocationQueue path doesn't register
    // initial target catId in worklistEntry.a2aTriggerMessageId map (only
    // downstream A2A targets register there). Trigger id arrives via
    // routeOptions.currentUserMessageId (QueueProcessor → routeExecution).
    //
    // route-serial.ts uses:
    //   const triggerId = worklistEntry.a2aTriggerMessageId.get(catId) ?? currentUserMessageId;
    //
    // This test locks that fallback contract — without it, queue-path
    // cross-post triggers wouldn't inject the reply hint.
    const { hydrateCrossThreadReplyHint } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = {
      getById: async (id) => {
        if (id !== 'queue-trigger-msg') return null;
        return {
          id: 'queue-trigger-msg',
          threadId: 'target-thread',
          userId: 'user-1',
          catId: 'opus',
          content: 'hi codex from another thread',
          mentions: ['codex'],
          timestamp: Date.now(),
          extra: {
            crossPost: { sourceThreadId: 'thread_source_via_queue_path' },
          },
        };
      },
    };

    // Simulate route-serial.ts wiring:
    //   - worklistMap is empty for the initial target via queue path
    //   - currentUserMessageId is the trigger id from QueueProcessor backfill
    const worklistMap = new Map();
    const catId = 'codex';
    const currentUserMessageId = 'queue-trigger-msg';
    const triggerId = worklistMap.get(catId) ?? currentUserMessageId;

    const result = await hydrateCrossThreadReplyHint(store, triggerId);
    assert.deepEqual(
      result,
      {
        sourceThreadId: 'thread_source_via_queue_path',
        senderCatId: 'opus',
      },
      'queue-path fallback must hydrate hint when worklist map empty',
    );
  });

  test('valid cross-thread relay → structured { sourceThreadId, senderCatId }', async () => {
    const { hydrateCrossThreadReplyHint } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = {
      getById: async () => ({
        id: 'relay-msg',
        threadId: 'thread-target',
        userId: 'user-1',
        catId: 'opus',
        content: '@codex please review',
        mentions: ['codex'],
        timestamp: Date.now(),
        extra: {
          crossPost: {
            sourceThreadId: 'thread_source_full_id_abc123def456',
            sourceInvocationId: 'inv-789',
          },
        },
      }),
    };
    const result = await hydrateCrossThreadReplyHint(store, 'relay-msg');
    assert.deepEqual(result, {
      sourceThreadId: 'thread_source_full_id_abc123def456',
      senderCatId: 'opus',
    });
  });
});
