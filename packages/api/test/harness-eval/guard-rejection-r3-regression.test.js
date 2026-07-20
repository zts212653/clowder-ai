/**
 * F257 V2 R3 regression tests — sol verdict 1×P1 + 5×P2.
 *
 * P2-1: countEpisodesAtLeast early-stop function
 * P2-2: isRegisteredLedgerId reverse whitelist (prototype-safe)
 * P2-4④: threshold truncated → conservative-true
 * P2-4⑤: bundle truncated → confidence 'low'
 *
 * [opus/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import {
  coalesceGuardEpisodes,
  countEpisodesAtLeast,
  EPISODE_GAP_MS,
} from '../../dist/infrastructure/harness-eval/guard-episode-coalescing.js';
import {
  GUARD_LEDGER_IDS,
  isRegisteredGuardId,
  isRegisteredLedgerId,
} from '../../dist/infrastructure/harness-eval/guard-ledger-registry.js';
import {
  checkGuardThreshold,
  ESCALATION_THRESHOLD,
} from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';
import { createHarnessLedgerGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T = 1700000000000;

function rawEvent(over = {}) {
  return {
    eventId: `evt-${over.timestamp ?? T}-${over.seq ?? 0}`,
    kind: 'http_rate_limit',
    threadId: 'thread_1',
    catId: 'cat_1',
    guardId: 'hold_ball_rate_limit',
    timestamp: T,
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 5,
    windowMs: 3600000,
    ...over,
  };
}

function createFakeRedis() {
  const store = new Map();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value, ...args) => {
      const hasNX = args.includes('NX');
      if (hasNX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    del: async (key) => {
      store.delete(key);
      return 1;
    },
    expire: async () => 1,
    _store: store,
  };
}

function triggerSuccess() {
  return {
    ok: true,
    domainId: 'eval:harness-ledger',
    threadId: 't1',
    messageId: 'm1',
    evalCatId: 'c1',
    invocationTriggered: true,
    triggerOutcome: 'dispatched',
  };
}

// ---------------------------------------------------------------------------
// P2-1: countEpisodesAtLeast — early-stop episode counter
// ---------------------------------------------------------------------------

describe('P2-1: countEpisodesAtLeast', () => {
  it('matches coalesceGuardEpisodes length for small inputs', () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 120_000, seq: 1 }),
      rawEvent({ timestamp: T + 240_000, seq: 2 }),
    ];
    const full = coalesceGuardEpisodes(events).length;
    const counted = countEpisodesAtLeast(events, 100);
    assert.equal(counted, full, 'exact count when k >> total');
    assert.equal(counted, 3);
  });

  it('early-stops at k when total > k', () => {
    // 5 separated events → 5 episodes; ask for at-least 3
    const events = Array.from({ length: 5 }, (_, i) => rawEvent({ timestamp: T + i * 120_000, seq: i }));
    const result = countEpisodesAtLeast(events, 3);
    assert.equal(result, 3, 'stops at k=3 even though 5 exist');
  });

  it('returns 0 for empty input', () => {
    assert.equal(countEpisodesAtLeast([], 5), 0);
  });

  it('returns 0 when k=0', () => {
    assert.equal(countEpisodesAtLeast([rawEvent()], 0), 0);
  });

  it('burst of 4 events within gap counts as 1 episode', () => {
    const burst = [
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 2300, seq: 1 }),
      rawEvent({ timestamp: T + 4700, seq: 2 }),
      rawEvent({ timestamp: T + 7044, seq: 3 }),
    ];
    assert.equal(countEpisodesAtLeast(burst, 10), 1);
  });

  it('untrusted keys each form solo episodes', () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0, threadId: '' }),
      rawEvent({ timestamp: T + 1000, seq: 1, threadId: '' }),
    ];
    assert.equal(countEpisodesAtLeast(events, 10), 2);
  });

  it('agrees with full coalescer on mixed trusted/untrusted events', () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 1000, seq: 1, threadId: 'unknown' }),
      rawEvent({ timestamp: T + 2000, seq: 2 }),
      rawEvent({ timestamp: T + 200_000, seq: 3 }),
    ];
    const full = coalesceGuardEpisodes(events).length;
    assert.equal(countEpisodesAtLeast(events, 100), full);
  });
});

// ---------------------------------------------------------------------------
// P2-2: isRegisteredLedgerId — reverse whitelist
// ---------------------------------------------------------------------------

describe('P2-2: isRegisteredLedgerId reverse whitelist', () => {
  it('returns true for all registered ledgerIds', () => {
    for (const ledgerId of Object.values(GUARD_LEDGER_IDS)) {
      assert.equal(isRegisteredLedgerId(ledgerId), true, `${ledgerId} should be registered`);
    }
  });

  it('returns false for unregistered strings', () => {
    assert.equal(isRegisteredLedgerId('evil/fake-pot'), false);
    assert.equal(isRegisteredLedgerId('mcp/nonexistent'), false);
  });

  it('returns false for prototype keys (prototype-safe)', () => {
    assert.equal(isRegisteredLedgerId('toString'), false);
    assert.equal(isRegisteredLedgerId('constructor'), false);
    assert.equal(isRegisteredLedgerId('__proto__'), false);
    assert.equal(isRegisteredLedgerId('hasOwnProperty'), false);
  });

  it('isRegisteredGuardId also rejects prototype keys (pre-existing P1-3)', () => {
    assert.equal(isRegisteredGuardId('toString'), false);
    assert.equal(isRegisteredGuardId('constructor'), false);
    assert.equal(isRegisteredGuardId('__proto__'), false);
  });
});

// ---------------------------------------------------------------------------
// P2-4④: threshold truncated → conservative-true
// ---------------------------------------------------------------------------

describe('P2-4④: truncated window → conservative-true threshold', () => {
  it('meetsThreshold=true when truncated even if episode count < threshold', async () => {
    // Fake log returns 1 event but truncated=true — lower bound, must be conservative
    const log = {
      queryWindowComplete: mock.fn(async () => ({
        events: [rawEvent({ timestamp: T, seq: 0 })],
        truncated: true,
      })),
    };
    const redis = createFakeRedis();
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(rawEvent(), { redis, guardRejectionLog: log, triggerEval });

    assert.equal(result.episodeCount, 1, 'actual count is 1');
    assert.equal(result.thresholdMet, true, 'truncated → conservative-true regardless of count');
    assert.equal(result.truncated, true, 'truncated flag propagated');
    assert.equal(result.escalated, true, 'should escalate on conservative-true');
    assert.equal(triggerEval.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// P2-4⑤: bundle truncated → confidence 'low'
// ---------------------------------------------------------------------------

describe('P2-4⑤: bundle truncated → confidence low', () => {
  it('committed bundle snapshot has confidence=low when truncated=true', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f257-r3-trunc-'));
    const evalRunId = 'hlr-1700000000000-abcd1234';
    const windowStartMs = T - 1000;
    const windowEndMs = T + 100_000;

    const storedSnapshot = {
      evalRunId,
      producedAt: new Date(T).toISOString(),
      window: { startMs: windowStartMs, endMs: windowEndMs, durationHours: 168 },
      totalEvents: 10000,
      byKind: { http_rate_limit: 10000 },
      byGuard: {
        hold_ball_rate_limit: {
          count: 10000,
          kinds: ['http_rate_limit'],
          episodeCount: 50,
          episodes: [],
        },
      },
      sampleAnchors: [],
      howCounted: 'zset-window-scan',
      truncated: true,
    };
    mkdirSync(join(root, 'run-snapshots'), { recursive: true });
    writeFileSync(join(root, 'run-snapshots', `${evalRunId}.json`), JSON.stringify(storedSnapshot));

    const generate = createHarnessLedgerGeneratorAdapter();
    const { bundleDir } = await generate(
      { id: 'test-r3-truncated-1', verdict: 'fix' },
      { kind: 'prompt-segments', windowStartMs, windowEndMs, evalRunId },
      { harnessFeedbackRoot: root, liveHarnessFeedbackRoot: root },
    );

    const bundle = JSON.parse(readFileSync(join(bundleDir, 'snapshot.json'), 'utf8'));

    assert.equal(bundle.truncated, true, 'truncated must survive into committed bundle');
    assert.equal(bundle.components[0].confidence, 'low', 'truncated → confidence low');
  });

  it('non-truncated bundle has confidence=medium when events exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f257-r3-normal-'));
    const evalRunId = 'hlr-1700000000001-abcd1234';
    const windowStartMs = T - 1000;
    const windowEndMs = T + 100_000;

    const storedSnapshot = {
      evalRunId,
      producedAt: new Date(T).toISOString(),
      window: { startMs: windowStartMs, endMs: windowEndMs, durationHours: 168 },
      totalEvents: 5,
      byKind: { http_rate_limit: 5 },
      byGuard: { hold_ball_rate_limit: { count: 5, kinds: ['http_rate_limit'], episodeCount: 3, episodes: [] } },
      sampleAnchors: [],
      howCounted: 'zset-window-scan',
      truncated: false,
    };
    mkdirSync(join(root, 'run-snapshots'), { recursive: true });
    writeFileSync(join(root, 'run-snapshots', `${evalRunId}.json`), JSON.stringify(storedSnapshot));

    const generate = createHarnessLedgerGeneratorAdapter();
    const { bundleDir } = await generate(
      { id: 'test-r3-normal-1', verdict: 'fix' },
      { kind: 'prompt-segments', windowStartMs, windowEndMs, evalRunId },
      { harnessFeedbackRoot: root, liveHarnessFeedbackRoot: root },
    );

    const bundle = JSON.parse(readFileSync(join(bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(bundle.truncated, false);
    assert.equal(bundle.components[0].confidence, 'medium');
  });
});
