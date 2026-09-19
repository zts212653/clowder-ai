import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { safeParseLifecycleMetadata } = await import(
  '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
);

describe('message lifecycle legacy parser', () => {
  it('drops v1 assigned intent while preserving actual delivery evidence', () => {
    const parsed = safeParseLifecycleMetadata(
      JSON.stringify({
        kind: 'input',
        orderKey: '100:source',
        dispatchRefs: [
          { targetId: 'never-delivered', phase: 'assigned' },
          { targetId: 'opus', phase: 'dispatched', statusMessageId: 'response-opus' },
          { targetId: 'codex', phase: 'settled', statusMessageId: 'response-codex', dispatchedAt: 200 },
        ],
      }),
    );

    assert.deepEqual(parsed?.dispatchRefs, [
      { targetId: 'opus', phase: 'dispatched', statusMessageId: 'response-opus' },
      { targetId: 'codex', phase: 'settled', statusMessageId: 'response-codex', dispatchedAt: 200 },
    ]);
  });
});
