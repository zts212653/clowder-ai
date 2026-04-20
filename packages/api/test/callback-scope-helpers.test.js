import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { deriveCallbackActor, resolveBoundThreadScope, resolveScopedThreadId } = await import(
  '../dist/routes/callback-scope-helpers.js'
);

describe('callback-scope-helpers', () => {
  const record = {
    invocationId: 'inv-1',
    threadId: 'thread-a',
    userId: 'user-1',
    catId: 'opus',
  };

  test('deriveCallbackActor returns the verified actor fields used by callback routes', () => {
    assert.deepEqual(deriveCallbackActor(record), {
      invocationId: 'inv-1',
      threadId: 'thread-a',
      userId: 'user-1',
      catId: 'opus',
    });
  });

  test('resolveBoundThreadScope allows same-thread writes', () => {
    assert.deepEqual(resolveBoundThreadScope(record, 'thread-a'), { ok: true, threadId: 'thread-a' });
  });

  test('resolveBoundThreadScope rejects cross-thread writes', () => {
    assert.deepEqual(resolveBoundThreadScope(record, 'thread-b'), {
      ok: false,
      statusCode: 403,
      error: 'Cross-thread write rejected',
    });
  });

  test('resolveScopedThreadId defaults to invocation thread when no override is given', async () => {
    const result = await resolveScopedThreadId(record, undefined, {});
    assert.deepEqual(result, { ok: true, threadId: 'thread-a' });
  });

  test('resolveScopedThreadId accepts explicit same-thread override', async () => {
    const result = await resolveScopedThreadId(record, 'thread-a', {});
    assert.deepEqual(result, { ok: true, threadId: 'thread-a' });
  });

  test('resolveScopedThreadId rejects cross-thread override when threadStore is missing', async () => {
    const result = await resolveScopedThreadId(record, 'thread-b', {
      threadStoreMissingError: 'Thread store not configured for cross-thread posting',
    });
    assert.deepEqual(result, {
      ok: false,
      statusCode: 503,
      error: 'Thread store not configured for cross-thread posting',
    });
  });

  test('resolveScopedThreadId rejects thread override owned by another user', async () => {
    const result = await resolveScopedThreadId(record, 'thread-b', {
      threadStore: {
        async get() {
          return { id: 'thread-b', createdBy: 'user-2' };
        },
      },
      accessDeniedError: 'Thread access denied',
    });
    assert.deepEqual(result, {
      ok: false,
      statusCode: 403,
      error: 'Thread access denied',
    });
  });

  test('resolveScopedThreadId allows thread override owned by the same user', async () => {
    const result = await resolveScopedThreadId(record, 'thread-b', {
      threadStore: {
        async get() {
          return { id: 'thread-b', createdBy: 'user-1' };
        },
      },
    });
    assert.deepEqual(result, { ok: true, threadId: 'thread-b' });
  });
});
