import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('callback thread scope resolver', () => {
  test('defaults to invocation thread when no override provided', async () => {
    const { resolveCallbackThreadScope } = await import('../dist/routes/callback-thread-scope.js');
    const result = await resolveCallbackThreadScope({
      record: { userId: 'user-1', catId: 'codex', threadId: 'thread-home' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.threadId, 'thread-home');
  });

  test('rejects cross-thread when policy is current-thread only', async () => {
    const { resolveCallbackThreadScope } = await import('../dist/routes/callback-thread-scope.js');
    const result = await resolveCallbackThreadScope({
      record: { userId: 'user-1', catId: 'codex', threadId: 'thread-home' },
      requestedThreadId: 'thread-other',
      allowCrossThread: false,
      crossThreadDeniedError: 'Cross-thread write rejected',
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.body.error, /Cross-thread write rejected/);
  });

  test('allows cross-thread when target thread belongs to invocation user', async () => {
    const { resolveCallbackThreadScope } = await import('../dist/routes/callback-thread-scope.js');
    const threadStore = {
      get: async (threadId) => ({ id: threadId, createdBy: 'user-1' }),
    };
    const result = await resolveCallbackThreadScope({
      record: { userId: 'user-1', catId: 'codex', threadId: 'thread-home' },
      requestedThreadId: 'thread-owned',
      allowCrossThread: true,
      threadStore,
    });
    assert.equal(result.ok, true);
    assert.equal(result.threadId, 'thread-owned');
  });

  test('rejects cross-thread when target thread belongs to another user', async () => {
    const { resolveCallbackThreadScope } = await import('../dist/routes/callback-thread-scope.js');
    const threadStore = {
      get: async (threadId) => ({ id: threadId, createdBy: 'user-2' }),
    };
    const result = await resolveCallbackThreadScope({
      record: { userId: 'user-1', catId: 'codex', threadId: 'thread-home' },
      requestedThreadId: 'thread-foreign',
      allowCrossThread: true,
      threadStore,
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.body.error, /Thread access denied/);
  });

  test('rejects cross-thread when thread store is missing', async () => {
    const { resolveCallbackThreadScope } = await import('../dist/routes/callback-thread-scope.js');
    const result = await resolveCallbackThreadScope({
      record: { userId: 'user-1', catId: 'codex', threadId: 'thread-home' },
      requestedThreadId: 'thread-other',
      allowCrossThread: true,
      crossThreadStoreMissingError: 'Thread store not configured for cross-thread scope checks',
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.match(result.body.error, /cross-thread scope checks/);
  });
});

