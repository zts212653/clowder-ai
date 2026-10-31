import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { requireInvocationRecordUpdate } from '../dist/domains/cats/services/agents/invocation/require-invocation-record-update.js';

describe('required invocation terminal updates', () => {
  test('accepts a durable store transition without an extra read', async () => {
    let reads = 0;
    await requireInvocationRecordUpdate({
      store: {
        update: async () => ({ id: 'invocation-ok', status: 'succeeded' }),
        get: async () => {
          reads += 1;
          return null;
        },
      },
      invocationId: 'invocation-ok',
      update: { status: 'succeeded', successfulCatIds: ['opus'] },
      writer: 'test writer',
    });
    assert.equal(reads, 0);
  });

  test('surfaces a rejected transition with the currently durable status', async () => {
    await assert.rejects(
      requireInvocationRecordUpdate({
        store: {
          update: async () => null,
          get: async () => ({ status: 'running' }),
        },
        invocationId: 'invocation-rejected',
        update: { status: 'succeeded', successfulCatIds: ['opus'] },
        writer: 'test writer',
      }),
      /test writer invocation update rejected.*current=running/i,
    );
  });
});
