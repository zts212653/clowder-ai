import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { applyLifecycleTerminal, validateLifecycleQueueEntry } = await import(
  '../dist/domains/cats/services/agents/invocation/message-lifecycle-kernel.js'
);

function inlineEntry(kind, body) {
  return {
    id: `${kind}-entry`,
    threadId: 'thread-1',
    kind,
    ...(kind === 'conversation_input' ? { sourceRecordId: 'message-1' } : {}),
    payload: { type: 'inline', body },
    from: { kind: 'user', userId: 'user-1' },
    targets: kind === 'private_input' ? ['codex'] : [],
    ownerAuthProvenance: 'strict',
    priority: 'normal',
    enqueuedAt: 100,
  };
}

describe('message lifecycle inline content validation', () => {
  it('rejects malformed content blocks for every inline QueueEntry kind', () => {
    for (const [kind, body] of [
      ['conversation_input', [{ type: 'text', text: 1 }]],
      ['conversation_input', [{ type: 'image', url: '/uploads/../secret.png' }]],
      ['private_input', [{ type: 'unknown', value: 'unsafe' }]],
    ]) {
      assert.equal(
        validateLifecycleQueueEntry(inlineEntry(kind, body)).valid,
        false,
        `${kind} must reject ${body[0].type}`,
      );
    }
  });

  it('rejects coerced owner provenance values', () => {
    assert.equal(
      validateLifecycleQueueEntry({
        ...inlineEntry('conversation_input', [{ type: 'text', text: 'hello' }]),
        ownerAuthProvenance: ['strict'],
      }).valid,
      false,
    );
  });

  it('rejects malformed inline routing warnings', () => {
    for (const routingWarnings of [
      { kind: 'cat_not_found', mention: '@missing', alternatives: [] },
      [{ kind: 'cat_disabled', catId: 'codex', displayName: 'Codex', alternatives: 'none' }],
    ]) {
      const candidate = inlineEntry('conversation_input', [{ type: 'text', text: 'hello' }]);
      candidate.payload.routingWarnings = routingWarnings;
      assert.equal(validateLifecycleQueueEntry(candidate).valid, false);
    }
  });

  it('rejects malformed content before committing a terminal bubble', () => {
    const bubble = {
      id: 'response-1',
      threadId: 'thread-1',
      orderKey: '2',
      invocationId: 'invocation-1',
      targetId: 'codex',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['message-1'],
      body: [],
      status: 'processing',
      startedAt: 100,
    };

    assert.deepEqual(
      applyLifecycleTerminal(bubble, {
        status: 'completed',
        body: [
          {
            type: 'file',
            url: '/uploads/../secret.pdf',
            fileName: 'secret.pdf',
            mimeType: 'application/pdf',
            fileSize: 1,
          },
        ],
        completedAt: 200,
      }),
      { outcome: 'conflict', reason: 'invalid_terminal' },
    );
  });

  it('rejects a non-string terminal reason', () => {
    const bubble = {
      id: 'response-1',
      threadId: 'thread-1',
      orderKey: '2',
      invocationId: 'invocation-1',
      targetId: 'codex',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['message-1'],
      body: [],
      status: 'processing',
      startedAt: 100,
    };

    assert.deepEqual(
      applyLifecycleTerminal(bubble, {
        status: 'failed',
        body: [{ type: 'text', text: 'failed' }],
        completedAt: 200,
        reason: 500,
      }),
      { outcome: 'conflict', reason: 'invalid_terminal' },
    );
  });
});
