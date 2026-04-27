/**
 * F052 regression: cross-thread messages from the same catId
 * must NOT be filtered out by the self-message exclusion in
 * assembleIncrementalContext.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { assembleIncrementalContext } = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');

function mockMsg(overrides) {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'test message',
    mentions: [],
    timestamp: Date.now(),
    origin: 'callback',
    ...overrides,
  };
}

function makeDeps(messages) {
  return {
    services: {},
    invocationDeps: {},
    messageStore: {
      getByThreadAfter: async () => messages,
    },
    deliveryCursorStore: {
      getCursor: async () => undefined,
    },
  };
}

describe('F052: crossPost self-filter exemption', () => {
  test('same-cat crossPost message is included in incremental context', async () => {
    const crossPostMsg = mockMsg({
      catId: 'opus',
      content: 'Cross-thread message from opus in another thread',
      extra: { crossPost: { sourceThreadId: 'other-thread-123' } },
    });
    const deps = makeDeps([crossPostMsg]);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.ok(
      result.contextText.includes('Cross-thread message from opus'),
      `crossPost from same catId should appear in context, got: "${result.contextText}"`,
    );
  });

  test('regular same-cat message is still filtered out', async () => {
    const selfMsg = mockMsg({
      catId: 'opus',
      content: 'My own regular message',
    });
    const deps = makeDeps([selfMsg]);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.ok(!result.contextText.includes('My own regular message'), 'regular self message should still be excluded');
    assert.ok(result.contextText.includes('[导航]'), 'KD-7: navigation header present even on empty delta');
  });

  test('whisper not intended for this cat is excluded from baton candidates (P1-R2)', async () => {
    const whisperMsg = mockMsg({
      catId: 'codex',
      content: '@opus 这条是悄悄话给 gemini 的',
      mentions: ['opus'],
      visibility: 'whisper',
      whisperTo: ['gemini'],
    });
    const deps = makeDeps([whisperMsg]);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.ok(
      !result.contextText.includes('悄悄话'),
      `whisper not intended for opus must not leak into navigation header, got: "${result.contextText}"`,
    );
    assert.ok(!result.navigationHeader?.includes('悄悄话'), 'whisper excerpt must not appear in navigation header');
  });

  test('other-cat crossPost is also included (no regression)', async () => {
    const otherCatCrossPost = mockMsg({
      catId: 'codex',
      content: 'Cross-thread from codex',
      extra: { crossPost: { sourceThreadId: 'other-thread-456' } },
    });
    const deps = makeDeps([otherCatCrossPost]);

    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.ok(
      result.contextText.includes('Cross-thread from codex'),
      'crossPost from different cat should be included',
    );
  });
});
