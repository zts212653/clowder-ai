/**
 * F257 V2 R3 regression tests — sol verdict 1×P1 + 5×P2.
 *
 * P2-2: isRegisteredLedgerId reverse whitelist (prototype-safe)
 * P2-4④: threshold truncated → conservative-true (pagewise)
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
  GUARD_LEDGER_IDS,
  isRegisteredGuardId,
  isRegisteredLedgerId,
} from '../../dist/infrastructure/harness-eval/guard-ledger-registry.js';
import { checkGuardThreshold } from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';
import { createHarnessLedgerGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.js';
import { createFakeEventSource, createFakeRedis, rawEvent, T, triggerSuccess } from './_guard-test-helpers.js';

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

describe('P2-4④: truncated window → conservative-true threshold (pagewise)', () => {
  it('meetsThreshold=true when hard cap hit even if episode count < threshold', async () => {
    // Seed 10,001 events forming 1 episode (same group, 1ms gaps) — exceeds
    // HARD_CAP so pagewise counter returns earlyStopReason='hard_cap'
    const events = Array.from({ length: 10_001 }, (_, i) =>
      rawEvent({ timestamp: T + i, seq: i, eventId: `cap-evt-${i}` }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(rawEvent({ timestamp: T + 10_001 }), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.episodeCount, 1, 'all events chain into 1 episode (1ms gaps)');
    assert.equal(result.thresholdMet, true, 'hard cap → conservative-true regardless of count');
    assert.equal(result.truncated, true, 'truncated flag propagated');
    assert.equal(result.escalated, true, 'should escalate on conservative-true');
    assert.equal(triggerEval.mock.callCount(), 1);
  });

  it('pagewise stops Redis I/O after threshold met (early-stop)', async () => {
    // 5 separated events → 5 episodes. Threshold is 3.
    // Pagewise should stop after finding 3rd episode, NOT fetch remaining pages.
    const events = Array.from({ length: 5 }, (_, i) =>
      rawEvent({ timestamp: T + i * 120_000, seq: i, eventId: `early-${i}` }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(rawEvent({ timestamp: T + 700_000 }), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.episodeCount, 3, 'early-stopped at k=3 (not actual 5)');
    assert.equal(result.episodeCountIsLowerBound, true, 'explicitly marked as lower bound');
    assert.equal(result.thresholdMet, true);
    assert.equal(result.pagesFetched, 1, 'all 5 events fit in 1 page — no excess fetching');
  });

  it('distinct-key episodes early-stop without scanning full window (sol R6 P2-1)', async () => {
    // 1001 events, each with a DIFFERENT threadId → 1001 distinct episodes.
    // Threshold is 3. Pagewise should stop after 3rd distinct key, NOT scan all 1001.
    // This proves the lower-bound counting (closed + openRunTs.size >= k).
    const events = Array.from({ length: 1001 }, (_, i) =>
      rawEvent({ timestamp: T + i * 120_000, seq: i, eventId: `dk-${i}`, threadId: `thread_${i}` }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(rawEvent({ timestamp: T + 200_000_000 }), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.episodeCount, 3, 'early-stopped at k=3');
    assert.equal(result.episodeCountIsLowerBound, true, 'marked as lower bound');
    assert.equal(result.rawEventCountIsLowerBound, true, 'raw count is also a lower bound');
    assert.equal(result.thresholdMet, true);
    assert.equal(result.pagesFetched, 1, 'stopped within first page — no excess I/O');
    assert.ok(result.rawEventCount <= 4, 'scanned ≤ 4 events before stopping (3 needed + at most 1 extra)');
  });

  it('exact count when episodes < threshold (no lower bound)', async () => {
    // 2 separated events → 2 episodes < threshold 3
    const events = [rawEvent({ timestamp: T, seq: 0 }), rawEvent({ timestamp: T + 120_000, seq: 1 })];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(rawEvent({ timestamp: T + 240_000 }), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.episodeCount, 2, 'exact count reported');
    assert.equal(result.episodeCountIsLowerBound, undefined, 'NOT marked as lower bound');
    assert.equal(result.thresholdMet, false);
    assert.equal(result.escalated, false);
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
