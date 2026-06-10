import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapabilityWakeupTrialProviderImpl } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-trial-provider-impl.js';

function makeTranscriptEvent({ eventNo, invocationId, sessionId, threadId, catId, event, t }) {
  return {
    v: 1,
    t: t ?? 1_800_000_000_000 + eventNo,
    threadId,
    catId,
    sessionId,
    cliSessionId: `cli-${sessionId}`,
    invocationId,
    eventNo,
    event,
  };
}

function buildMocks(overrides = {}) {
  const sessions = new Map([
    ['session-1', { id: 'session-1', threadId: 'thread-1', catId: 'codex', userId: 'default-user' }],
    ['session-2', { id: 'session-2', threadId: 'thread-2', catId: 'opus', userId: 'default-user' }],
  ]);
  return {
    sessionStore: {
      get: (sessionId) => sessions.get(sessionId) ?? null,
    },
    transcriptReader: {
      readEvents: async (sessionId, threadId, catId) => ({
        events: [
          makeTranscriptEvent({
            eventNo: 0,
            invocationId: `${sessionId}-inv-1`,
            sessionId,
            threadId,
            catId,
            event: {
              type: 'text',
              content: `${'word '.repeat(80)}\n- bullet1\n- bullet2\n- bullet3\n\`\`\`md\nx\n\`\`\``,
            },
          }),
        ],
        total: 1,
      }),
    },
    toolEventLog: { readByThread: async () => [] },
    skillLoadEventLog: { readBySession: async () => [] },
    ...overrides,
  };
}

describe('CapabilityWakeupTrialProviderImpl window scan (AC-F8)', () => {
  it('requires ownerUserId when sessionIds are omitted', async () => {
    const provider = new CapabilityWakeupTrialProviderImpl(
      buildMocks({
        sessionEnumerator: {
          listWindow: async () => {
            throw new Error('unreachable');
          },
        },
      }),
    );

    await assert.rejects(
      provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9_999_999_999_999,
      }),
      /owner_user_required.*window scan/i,
    );
  });

  it('uses sessionEnumerator when sessionIds are omitted', async () => {
    let enumerated = 0;
    const provider = new CapabilityWakeupTrialProviderImpl(
      buildMocks({
        sessionEnumerator: {
          listWindow: async (input) => {
            enumerated++;
            const { windowStartMs, windowEndMs, ownerUserId } = input;
            assert.deepEqual(Object.keys(input).sort(), ['ownerUserId', 'windowEndMs', 'windowStartMs']);
            assert.equal(windowStartMs, 0);
            assert.equal(windowEndMs, 9_999_999_999_999);
            assert.equal(ownerUserId, 'default-user');
            return [
              {
                sessionId: 'session-1',
                threadId: 'thread-1',
                catId: 'codex',
                userId: 'default-user',
                family: 'maine-coon',
              },
              {
                sessionId: 'session-2',
                threadId: 'thread-2',
                catId: 'opus',
                userId: 'default-user',
                family: 'ragdoll',
              },
            ];
          },
        },
      }),
    );

    const trials = await provider.resolve(
      {
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9_999_999_999_999,
      },
      { ownerUserId: 'default-user' },
    );

    assert.equal(enumerated, 1);
    assert.ok(trials.length >= 2, 'expected trials from enumerated sessions');
    assert.deepEqual(new Set(trials.map((trial) => trial.sessionId)), new Set(['session-1', 'session-2']));
    assert.deepEqual(new Set(trials.map((trial) => trial.family)), new Set(['maine-coon', 'ragdoll']));
  });
});
