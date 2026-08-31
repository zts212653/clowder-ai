import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { projectLifecycleAppendAction } = await import(
  '../dist/domains/cats/services/agents/invocation/lifecycle-append-projection.js'
);

function entry(overrides = {}) {
  return {
    id: 'entry-1',
    threadId: 'thread-1',
    userId: 'user-1',
    from: { kind: 'user', userId: 'user-1' },
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    content: 'please continue',
    messageId: 'message-1',
    mergedMessageIds: [],
    targetCats: ['codex'],
    intent: 'execute',
    status: 'queued',
    createdAt: 1,
    autoExecute: false,
    priority: 'normal',
    ...overrides,
  };
}

function tracker({ dispatcher = true, activeRun = true, userId = 'user-1' } = {}) {
  const run = {
    threadId: 'thread-1',
    targetId: 'codex',
    invocationId: 'turn-1',
    responseMessageId: 'response-1',
    inputEntryIds: ['old-entry'],
    inputMessageIds: ['old-message'],
    privateInputEntryIds: [],
    startedAt: 1,
  };
  return {
    has: () => true,
    getUserId: () => userId,
    cancel: () => ({ cancelled: false, catIds: [] }),
    getActiveSlots: () => [{ catId: 'codex', startedAt: 1, ...(activeRun ? { activeRun: run } : {}) }],
    getAgentClientActiveRunDispatcher: () =>
      dispatcher
        ? {
            invocationId: 'turn-1',
            capabilities: { append: true, steer: true },
            handle: { provider: 'openai_codex', carrier: 'codex_app_server', threadId: 'native-1', turnId: 'turn-1' },
            dispatch: async () => ({ accepted: true, handle: {} }),
          }
        : undefined,
  };
}

describe('lifecycle Append action projection', () => {
  it('projects the exact Queue and Active Run fences only from a live supporting dispatcher', () => {
    const result = projectLifecycleAppendAction({
      threadId: 'thread-1',
      userId: 'user-1',
      queueRevision: 'revision-1',
      entry: entry(),
      invocationTracker: tracker(),
    });
    assert.deepEqual(result, {
      available: true,
      action: {
        kind: 'append',
        expectedQueueRevision: 'revision-1',
        expectedRuns: [{ targetId: 'codex', invocationId: 'turn-1', responseMessageId: 'response-1' }],
      },
    });
  });

  it('fails closed for ACP/unsupported clients, missing Active Runs, or another owner', () => {
    for (const [expected, invocationTracker] of [
      ['client_unsupported', tracker({ dispatcher: false })],
      ['active_run_missing', tracker({ activeRun: false })],
      ['owner_mismatch', tracker({ userId: 'other-user' })],
    ]) {
      assert.deepEqual(
        projectLifecycleAppendAction({
          threadId: 'thread-1',
          userId: 'user-1',
          queueRevision: 'revision-1',
          entry: entry(),
          invocationTracker,
        }),
        { available: false, reason: expected },
      );
    }
  });
});
