import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapabilityWakeupTrialProviderImpl } from '../../dist/infrastructure/harness-eval/capability-wakeup/capability-wakeup-trial-provider-impl.js';

// Inline transcriptEvent (test-helpers.js hardcodes threadId='thread-cap'/sessionId='session-cap';
// our session records use thread-1/session-1, and filterTranscriptEvents filters by both —
// see eval-capability-wakeup-trace.ts:filterTranscriptEvents).
function makeTranscriptEvent({ eventNo, invocationId, sessionId, threadId, catId, event, t }) {
  return {
    v: 1,
    t: t ?? Date.now() + eventNo,
    threadId,
    catId,
    sessionId,
    cliSessionId: `cli-${sessionId}`,
    invocationId,
    eventNo,
    event,
  };
}

/**
 * F192 Phase H 收尾 PR-2 — provider impl (replay/reclassify chain).
 *
 * 砚砚 R1 P1 locks:
 * - real ports (SessionRecordReader / TranscriptEventReader / ToolEventReader / SkillLoadEventReader)
 * - AC-F8: selector.sessionIds is an optional narrowing when sessionEnumerator is wired
 * - constructor fail closed on missing port (no silent empty-array → fake miss)
 */

function buildMocks(overrides = {}) {
  const sessions = new Map([
    ['session-1', { id: 'session-1', threadId: 'thread-1', catId: 'gpt52', userId: 'default-user' }],
    ['session-2', { id: 'session-2', threadId: 'thread-2', catId: 'gpt52', userId: 'default-user' }],
  ]);
  return {
    sessionStore: {
      get: (sessionId) => sessions.get(sessionId) ?? null,
    },
    transcriptReader: {
      // Default: rich-messaging fires (>50 tokens + 3 structured signals)
      readEvents: async (sessionId, threadId, catId) => {
        const richText = `${'word '.repeat(80)}\n- bullet1\n- bullet2\n- bullet3\n\`\`\`md\nhello\n\`\`\`\n| a | b |\n|---|---|\n| 1 | 2 |`;
        const events = [
          makeTranscriptEvent({
            eventNo: 0,
            invocationId: `${sessionId}-inv-1`,
            sessionId,
            threadId,
            catId,
            event: { type: 'text', content: richText },
          }),
          makeTranscriptEvent({
            eventNo: 1,
            invocationId: `${sessionId}-inv-2`,
            sessionId,
            threadId,
            catId,
            event: { type: 'text', content: 'show me the options in a nicer format' },
          }),
        ];
        return { events, total: events.length };
      },
    },
    toolEventLog: { readByThread: async () => [] },
    skillLoadEventLog: { readBySession: async () => [] },
    ...overrides,
  };
}

// PR-2 R9 P1: constructor fail-closed describe block extracted to
// `capability-wakeup-trial-provider-impl-constructor.test.js` (AGENTS.md 350-line limit).

describe('CapabilityWakeupTrialProviderImpl (砚砚 R1 P1 — replay/reclassify)', () => {
  describe('resolve(selector)', () => {
    it('throws when selector.kind is not capability-wakeup-trial-window', async () => {
      const provider = new CapabilityWakeupTrialProviderImpl(buildMocks());
      await assert.rejects(
        provider.resolve({ kind: 'capability-wakeup-trial-ids', trialIds: ['t1'] }),
        /unsupported selector kind|trial-ids/i,
      );
    });

    it('throws when selector.sessionIds missing and no sessionEnumerator is wired', async () => {
      const provider = new CapabilityWakeupTrialProviderImpl(buildMocks());
      await assert.rejects(
        provider.resolve(
          {
            kind: 'capability-wakeup-trial-window',
            capability: 'rich-messaging',
            windowStartMs: 0,
            windowEndMs: 9999999999999,
          },
          { ownerUserId: 'default-user' },
        ),
        /sessionEnumerator is required/i,
      );
    });

    it('throws when selector.sessionIds is empty array and no sessionEnumerator is wired', async () => {
      const provider = new CapabilityWakeupTrialProviderImpl(buildMocks());
      await assert.rejects(
        provider.resolve(
          {
            kind: 'capability-wakeup-trial-window',
            capability: 'rich-messaging',
            windowStartMs: 0,
            windowEndMs: 9999999999999,
            sessionIds: [],
          },
          { ownerUserId: 'default-user' },
        ),
        /sessionEnumerator is required/i,
      );
    });

    it('throws when sessionId not found in store', async () => {
      const provider = new CapabilityWakeupTrialProviderImpl(buildMocks());
      await assert.rejects(
        provider.resolve({
          kind: 'capability-wakeup-trial-window',
          capability: 'rich-messaging',
          windowStartMs: 0,
          windowEndMs: 9999999999999,
          sessionIds: ['nonexistent-session'],
        }),
        /session_not_found.*nonexistent-session/,
      );
    });

    it('returns classified trials for valid window + sessionIds', async () => {
      const sessionStoreGets = [];
      const provider = new CapabilityWakeupTrialProviderImpl(
        buildMocks({
          sessionStore: {
            get: (sessionId) => {
              sessionStoreGets.push(sessionId);
              return { threadId: 'thread-1', catId: 'gpt52', userId: 'default-user' };
            },
          },
        }),
      );
      const trials = await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['session-1'],
      });
      assert.deepEqual(sessionStoreGets, ['session-1']);
      assert.ok(Array.isArray(trials), 'returns array');
      assert.ok(trials.length >= 1, 'expected at least one rich-messaging trial');
      for (const t of trials) {
        assert.equal(t.capability, 'rich-messaging');
      }
    });

    it('filters out trials with timeSpan.startMs outside [windowStartMs, windowEndMs)', async () => {
      const provider = new CapabilityWakeupTrialProviderImpl(buildMocks());
      // Window in the past — all trials' timeSpan.startMs >= now, so none should match.
      const trials = await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 1, // 1 ms past epoch — way before now
        sessionIds: ['session-1'],
      });
      assert.deepEqual(trials, []);
    });

    // cloud R7 P2 (PR-2): without dedup, duplicate sessionId would replay same
    // transcript multiple times → inflated trial counts → biased verdict.
    it('dedupes duplicate sessionIds (no inflated trial count) (cloud R7 P2)', async () => {
      let calls = 0;
      const mocks = buildMocks({
        transcriptReader: {
          readEvents: async (sessionId, threadId, catId) => {
            calls++;
            const richText = `${'word '.repeat(80)}\n- bullet1\n- bullet2\n- bullet3\n\`\`\`md\nhello\n\`\`\`\n| a | b |\n|---|---|\n| 1 | 2 |`;
            return {
              events: [
                makeTranscriptEvent({
                  eventNo: 0,
                  invocationId: `${sessionId}-inv-1`,
                  sessionId,
                  threadId,
                  catId,
                  event: { type: 'text', content: richText },
                }),
                makeTranscriptEvent({
                  eventNo: 1,
                  invocationId: `${sessionId}-inv-2`,
                  sessionId,
                  threadId,
                  catId,
                  event: { type: 'text', content: 'show me' },
                }),
              ],
              total: 2,
            };
          },
        },
      });
      const provider = new CapabilityWakeupTrialProviderImpl(mocks);
      const trialsWithDupe = await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['session-1', 'session-1', 'session-1'], // 3x dupe
      });
      assert.equal(calls, 1, `expected 1 readEvents call (dedupe); got ${calls}`);
      const trialsNoDupe = await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['session-1'],
      });
      assert.equal(trialsWithDupe.length, trialsNoDupe.length, 'dupe sessionIds must NOT inflate trial count');
    });

    it('combines trials across multiple sessionIds', async () => {
      const provider = new CapabilityWakeupTrialProviderImpl(buildMocks());
      const trials = await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['session-1', 'session-2'],
      });
      const sessionIdsSeen = new Set(trials.map((t) => t.sessionId));
      assert.ok(sessionIdsSeen.size >= 1, `expected at least 1 unique sessionId, got ${sessionIdsSeen.size}`);
    });

    it('returns empty when no rules match capability', async () => {
      const provider = new CapabilityWakeupTrialProviderImpl(buildMocks());
      const trials = await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'nonexistent-capability',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['session-1'],
      });
      assert.deepEqual(trials, []);
    });

    it('paginates transcript reader if nextCursor returned', async () => {
      let calls = 0;
      const mocks = buildMocks({
        transcriptReader: {
          readEvents: async (sessionId, threadId, catId, cursor) => {
            calls++;
            if (!cursor) {
              return {
                events: [
                  makeTranscriptEvent({
                    eventNo: 0,
                    invocationId: 'inv-1',
                    sessionId,
                    threadId,
                    catId,
                    event: { type: 'text', content: `first batch ${'word '.repeat(60)}` },
                  }),
                ],
                nextCursor: { eventNo: 1 },
                total: 2,
              };
            }
            return {
              events: [
                makeTranscriptEvent({
                  eventNo: 1,
                  invocationId: 'inv-2',
                  sessionId,
                  threadId,
                  catId,
                  event: {
                    type: 'text',
                    content: `second batch\n- bullet1\n- bullet2\n- bullet3\n\`\`\`md\nx\n\`\`\` ${'word '.repeat(60)}`,
                  },
                }),
              ],
              total: 2,
            };
          },
        },
      });
      const provider = new CapabilityWakeupTrialProviderImpl(mocks);
      await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['session-1'],
      });
      assert.ok(calls >= 2, `expected at least 2 readEvents calls for pagination, got ${calls}`);
    });

    it('applies ruleIds narrowing', async () => {
      const provider = new CapabilityWakeupTrialProviderImpl(buildMocks());
      // First with full ruleset — gets trials
      const trialsFull = await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['session-1'],
      });
      // Then with narrowing to a non-matching ruleId — should return empty
      const trialsNarrow = await provider.resolve({
        kind: 'capability-wakeup-trial-window',
        capability: 'rich-messaging',
        windowStartMs: 0,
        windowEndMs: 9999999999999,
        sessionIds: ['session-1'],
        ruleIds: ['no-such-rule'],
      });
      assert.ok(trialsFull.length > 0);
      assert.deepEqual(trialsNarrow, []);
    });
  });
});
