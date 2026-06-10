import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapabilityWakeupTrialProviderImpl } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-trial-provider-impl.js';

function buildProvider(overrides = {}) {
  return new CapabilityWakeupTrialProviderImpl({
    sessionStore: {
      get: () => ({ threadId: 'thread-1', catId: 'gpt52', userId: 'default-user' }),
    },
    transcriptReader: {
      readEvents: async () => ({ events: [], total: 0 }),
    },
    toolEventLog: { readByThread: async () => [] },
    skillLoadEventLog: { readBySession: async () => [] },
    ...overrides,
  });
}

describe('CapabilityWakeupTrialProviderImpl owner scope', () => {
  it('throws when selector.sessionIds missing and owner scope is omitted', async () => {
    const provider = buildProvider({
      sessionEnumerator: {
        listWindow: async () => {
          throw new Error('unreachable');
        },
      },
    });
    await assert.rejects(
      provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
      }),
      /owner_user_required.*window scan/i,
    );
  });

  it('hides explicit sessionIds outside the owner scope', async () => {
    let transcriptCalls = 0;
    const provider = buildProvider({
      sessionStore: {
        get: () => ({ threadId: 'thread-1', catId: 'gpt52', userId: 'other-user' }),
      },
      transcriptReader: {
        readEvents: async () => {
          transcriptCalls++;
          return { events: [], total: 0 };
        },
      },
    });

    await assert.rejects(
      provider.resolve(
        {
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['session-1'],
        },
        { ownerUserId: 'default-user' },
      ),
      /session_not_found.*session-1/,
    );
    assert.equal(transcriptCalls, 0, 'provider must not replay a session outside owner scope');
  });
});
