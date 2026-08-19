import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DailyContextReflectionProducer } from '../../dist/domains/memory/DailyContextReflectionProducer.js';

const NOW = Date.parse('2026-07-26T11:15:00.000Z'); // 04:15 America/Los_Angeles

function sealedSession(id, threadId, catId, sealedAt, overrides = {}) {
  return {
    id,
    cliSessionId: `cli-${id}`,
    threadId,
    catId,
    userId: 'owner-1',
    seq: 0,
    status: 'sealed',
    messageCount: 1,
    createdAt: sealedAt - 10_000,
    updatedAt: sealedAt,
    sealedAt,
    sealReason: 'threshold',
    ...overrides,
  };
}

function setup(chains, reflectionOverrides = {}, producerOverrides = {}) {
  const calls = [];
  const producer = new DailyContextReflectionProducer({
    ownerUserId: 'owner-1',
    threadStore: {
      list: async () =>
        [...new Set([...chains.values()].flat().map((session) => session.threadId))].map((id) => ({ id })),
    },
    sessionChainStore: {
      getChainByThread: async (threadId) => chains.get(threadId) ?? [],
    },
    reflectionProducer: {
      reflectSessions: async (seals, options) => {
        calls.push({ seals, options });
        return {
          householdLocalDate: '2026-07-26',
          extracted: seals.length,
          accepted: seals.length,
          duplicates: 0,
          rejected: 0,
          cuesDelivered: 0,
          outputs: [],
          ...reflectionOverrides,
        };
      },
    },
    now: () => NOW,
    getHouseholdTimeZone: () => 'America/Los_Angeles',
    ...producerOverrides,
  });
  return { producer, calls };
}

describe('F271 DailyContextReflectionProducer', () => {
  test('selects the previous household day and merges sealed sessions once per cat', async () => {
    const previousMorning = Date.parse('2026-07-25T17:00:00.000Z');
    const previousEvening = Date.parse('2026-07-26T03:00:00.000Z');
    const currentDay = Date.parse('2026-07-26T08:30:00.000Z');
    const chains = new Map([
      [
        'thread-a',
        [
          sealedSession('session-a1', 'thread-a', 'codex-sol', previousMorning),
          sealedSession('session-a2', 'thread-a', 'codex-sol', previousEvening),
          sealedSession('session-current', 'thread-a', 'codex-sol', currentDay),
        ],
      ],
      [
        'thread-b',
        [
          sealedSession('session-b1', 'thread-b', 'kimi', previousEvening),
          sealedSession('session-active', 'thread-b', 'kimi', previousEvening, {
            status: 'active',
            sealedAt: undefined,
            createdAt: previousMorning,
            updatedAt: currentDay,
          }),
          sealedSession('session-other-owner', 'thread-b', 'kimi', previousEvening, { userId: 'owner-2' }),
        ],
      ],
    ]);
    const { producer, calls } = setup(chains);

    const result = await producer.run();

    assert.equal(result.sourceLocalDate, '2026-07-25');
    assert.equal(result.sessionsConsidered, 4);
    assert.equal(result.catBatches, 2);
    assert.equal(result.accepted, 4);
    assert.equal(result.quiet, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => ({
        sessionIds: call.seals.map((seal) => seal.sessionId),
        sourceLocalDate: call.options.sourceLocalDate,
      })),
      [
        { sessionIds: ['session-a1', 'session-a2'], sourceLocalDate: '2026-07-25' },
        { sessionIds: ['session-b1', 'session-active'], sourceLocalDate: '2026-07-25' },
      ],
    );
  });

  test('treats a day with no eligible sessions as a healthy quiet day', async () => {
    const { producer, calls } = setup(new Map(), {}, { monotonicNow: () => 0 });

    const result = await producer.run();

    assert.deepEqual(result, {
      sourceLocalDate: '2026-07-25',
      sessionsConsidered: 0,
      catBatches: 0,
      extracted: 0,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      cuesDelivered: 0,
      quiet: true,
      telemetry: {
        threadCount: 0,
        threadListMs: 0,
        sessionScanMs: 0,
        reflectionMs: 0,
        totalMs: 0,
        activeWorkAtEnd: 0,
      },
    });
    assert.deepEqual(calls, []);
  });

  test('does not report a budget-rejected extraction as a quiet day', async () => {
    const previousMorning = Date.parse('2026-07-25T17:00:00.000Z');
    const chains = new Map([['thread-a', [sealedSession('session-a1', 'thread-a', 'codex-sol', previousMorning)]]]);
    const { producer } = setup(chains, {
      extracted: 1,
      accepted: 0,
      rejected: 1,
    });

    const result = await producer.run();

    assert.equal(result.extracted, 1);
    assert.equal(result.rejected, 1);
    assert.equal(result.quiet, false);
  });

  test('reports bounded phase timings and zero active work at successful completion', async () => {
    const previousMorning = Date.parse('2026-07-25T17:00:00.000Z');
    const chains = new Map([['thread-a', [sealedSession('session-a1', 'thread-a', 'codex-sol', previousMorning)]]]);
    const ticks = [0, 5, 5, 17, 17, 26, 26];
    const { producer } = setup(chains, {}, { monotonicNow: () => ticks.shift() ?? 26 });

    const result = await producer.run();

    assert.deepEqual(result.telemetry, {
      threadCount: 1,
      threadListMs: 5,
      sessionScanMs: 12,
      reflectionMs: 9,
      totalMs: 26,
      activeWorkAtEnd: 0,
    });
  });

  test('stops starting session scans and leaves no active scan after its signal expires', async () => {
    const active = new Set();
    const started = [];
    const producer = new DailyContextReflectionProducer({
      ownerUserId: 'owner-1',
      threadStore: {
        list: async () => [{ id: 'thread-a' }, { id: 'thread-b' }, { id: 'thread-c' }],
      },
      sessionChainStore: {
        getChainByThread(threadId, options = {}) {
          started.push(threadId);
          active.add(threadId);
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              active.delete(threadId);
              resolve([]);
            }, 1_000);
            options.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                active.delete(threadId);
                reject(options.signal.reason);
              },
              { once: true },
            );
          });
        },
      },
      reflectionProducer: {
        reflectSessions: async () => {
          throw new Error('aborted scan must not reach reflection');
        },
      },
      now: () => NOW,
      getHouseholdTimeZone: () => 'America/Los_Angeles',
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = producer.run({ signal: controller.signal });
    setTimeout(() => controller.abort(new Error('daily reflection deadline exceeded')), 20);

    await assert.rejects(pending, /daily reflection deadline exceeded/);
    assert.ok(Date.now() - startedAt < 500, 'abort must beat the 1s backing session scan even under full-suite load');
    assert.equal(active.size, 0);
    assert.deepEqual(started, ['thread-a']);
  });
});
