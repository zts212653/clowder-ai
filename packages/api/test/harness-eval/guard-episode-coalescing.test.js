import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';

import {
  coalesceGuardEpisodes,
  EPISODE_GAP_MS,
} from '../../dist/infrastructure/harness-eval/guard-episode-coalescing.js';
import { checkGuardThreshold } from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';
import { produceHarnessLedgerRunSnapshot } from '../../dist/infrastructure/harness-eval/harness-ledger-snapshot-provider.js';
import { createHarnessLedgerGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.js';

// ---------------------------------------------------------------------------
// F257 V2/Phase B — PR #41 verdict regression (episode coalescing).
//
// Verdict 2026-07-19-harness-ledger-burst-coalescing-fix-c2 (MERGED, fix):
//   "Change F257 escalation accounting to preserve rawEventCount but coalesce
//    same-guard, same-thread, same-cat rapid retries into a distinct episode
//    count used by the 3-per-7d threshold; carry episode and sample-anchor
//    metadata into the committed bundle."
//
// Three mandated regressions (sol scope ruling, msg 0001784468875582):
//   R1: four hold_ball 429s in one 7-second episode → rawEventCount=4,
//       episodeCount=1, does NOT alone trigger the three-episode threshold
//   R2: three separated episodes still trigger
//   R3: isolated A2A streak-4 block stays independently attributable
//
// Coalescing contract (sol ruling):
//   - group key: guardId + threadId + catId — ALL three must be trusted
//     non-empty values, else the event forms its own episode (no unknown-merge)
//   - stable sort: timestamp asc, tie-break by per-event unique id (eventId —
//     the raw-rejection coordinate; episodeId is derived, never interchanged)
//   - adjacent gap ≤ EPISODE_GAP_MS (named constant, 60s, no per-guard config
//     surface in V2) chains events into one episode
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

/** The PR #41 burst: 4 hold_ball 429s spanning 7.044 seconds. */
function verdictBurst(base = T) {
  return [
    rawEvent({ timestamp: base, seq: 0 }),
    rawEvent({ timestamp: base + 2300, seq: 1 }),
    rawEvent({ timestamp: base + 4700, seq: 2 }),
    rawEvent({ timestamp: base + 7044, seq: 3 }),
  ];
}

function a2aBlockEvent(over = {}) {
  return {
    eventId: `evt-a2a-${over.timestamp ?? T}`,
    kind: 'route_decision_block',
    threadId: 'thread_2',
    catId: 'cat_2',
    guardId: 'a2a_pingpong_block',
    timestamp: T,
    correlationConfidence: 'window',
    fromCatId: 'cat_2',
    targetCatId: 'cat_3',
    streakCount: 4,
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
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
    expire: async () => 1,
    _store: store,
  };
}

/** Fake event log backed by a fixed event array; filters like the real one. */
function createFakeLogWithEvents(events) {
  const filter = (opts) =>
    events.filter(
      (e) =>
        (!opts.guardId || e.guardId === opts.guardId) &&
        (!opts.threadId || e.threadId === opts.threadId) &&
        (!opts.catId || e.catId === opts.catId) &&
        e.timestamp >= opts.since &&
        e.timestamp < (opts.until ?? Number.POSITIVE_INFINITY),
    );
  return {
    queryWindow: mock.fn(async (opts) => filter(opts)),
    queryWindowStrict: mock.fn(async (opts) => filter(opts)),
    countByGuard: mock.fn(async (guardId, since, until) => filter({ guardId, since, until }).length),
    append: async () => {},
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
// Part 1 — canonical coalescer (pure function)
// ---------------------------------------------------------------------------

describe('coalesceGuardEpisodes — canonical coalescer', () => {
  it('exports EPISODE_GAP_MS = 60s named constant (V2: no per-guard config surface)', () => {
    assert.equal(EPISODE_GAP_MS, 60_000);
  });

  it('R1 core: PR #41 burst (4 events / 7.044s) coalesces into ONE episode preserving rawEventCount=4', () => {
    const episodes = coalesceGuardEpisodes(verdictBurst());
    assert.equal(episodes.length, 1, 'burst must form exactly one episode');
    const ep = episodes[0];
    assert.equal(ep.rawEventCount, 4, 'rawEventCount preserved');
    assert.equal(ep.guardId, 'hold_ball_rate_limit');
    assert.equal(ep.startMs, T);
    assert.equal(ep.endMs, T + 7044);
    assert.ok(Array.isArray(ep.sampleAnchors) && ep.sampleAnchors.length > 0, 'episode carries sample anchors');
    assert.ok(
      ep.sampleAnchors.every((a) => a.eventId && typeof a.timestamp === 'number'),
      'anchors carry eventId + timestamp for independent recheck (PR #41 provenance gap)',
    );
  });

  it('R2 core: three separated episodes (gap > 60s) stay distinct', () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 120_000, seq: 1 }),
      rawEvent({ timestamp: T + 240_000, seq: 2 }),
    ];
    const episodes = coalesceGuardEpisodes(events);
    assert.equal(episodes.length, 3, 'separated events form separate episodes');
    assert.ok(episodes.every((e) => e.rawEventCount === 1));
  });

  it('chain semantics: adjacent gap ≤ 60s extends the episode even when total span > 60s', () => {
    // 3 events at 0s / 50s / 100s — each adjacent gap is 50s (≤60s), total span 100s.
    // Gap-based chaining (sol ruling) keeps them ONE episode; a fixed window would split.
    const events = [
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 50_000, seq: 1 }),
      rawEvent({ timestamp: T + 100_000, seq: 2 }),
    ];
    const episodes = coalesceGuardEpisodes(events);
    assert.equal(episodes.length, 1, 'chained retries stay one episode');
    assert.equal(episodes[0].rawEventCount, 3);
  });

  it('boundary: gap exactly 60s merges; 60s+1ms splits', () => {
    const merged = coalesceGuardEpisodes([
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + EPISODE_GAP_MS, seq: 1 }),
    ]);
    assert.equal(merged.length, 1, 'gap == EPISODE_GAP_MS merges');

    const split = coalesceGuardEpisodes([
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + EPISODE_GAP_MS + 1, seq: 1 }),
    ]);
    assert.equal(split.length, 2, 'gap > EPISODE_GAP_MS splits');
  });

  it('R3 core: mixed stream — A2A streak-4 block never merges into the hold_ball burst', () => {
    const events = [...verdictBurst(), a2aBlockEvent({ timestamp: T + 3000 })];
    const episodes = coalesceGuardEpisodes(events);
    assert.equal(episodes.length, 2, 'one hold_ball episode + one independent A2A episode');
    const holdBall = episodes.find((e) => e.guardId === 'hold_ball_rate_limit');
    const a2a = episodes.find((e) => e.guardId === 'a2a_pingpong_block');
    assert.equal(holdBall.rawEventCount, 4);
    assert.equal(a2a.rawEventCount, 1, 'A2A block independently attributable');
  });

  it('does not merge across threadId or catId even within gap', () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 1000, seq: 1, threadId: 'thread_other' }),
      rawEvent({ timestamp: T + 2000, seq: 2, catId: 'cat_other' }),
    ];
    const episodes = coalesceGuardEpisodes(events);
    assert.equal(episodes.length, 3, 'guardId+threadId+catId is the full group key');
  });

  it('untrusted key (empty / unknown) → event forms its own episode, never merged', () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0, threadId: '' }),
      rawEvent({ timestamp: T + 1000, seq: 1, threadId: '' }),
      rawEvent({ timestamp: T + 2000, seq: 2, catId: 'unknown' }),
      rawEvent({ timestamp: T + 3000, seq: 3, catId: 'unknown' }),
    ];
    const episodes = coalesceGuardEpisodes(events);
    assert.equal(episodes.length, 4, 'untrusted identity must not co-mingle into shared episodes');
  });

  it('stable deterministic output: unordered input + same-timestamp ties produce identical episodes', () => {
    const shuffled = [
      rawEvent({ timestamp: T + 4700, seq: 2 }),
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 7044, seq: 3 }),
      rawEvent({ timestamp: T + 2300, seq: 1 }),
    ];
    const a = coalesceGuardEpisodes(shuffled);
    const b = coalesceGuardEpisodes([...shuffled].reverse());
    assert.deepEqual(a, b, 'coalescing must be input-order independent (replayable)');
    assert.equal(a.length, 1);
    assert.ok(a[0].episodeId, 'episode has derived episodeId');
    assert.notEqual(a[0].episodeId, a[0].sampleAnchors[0].eventId, 'episodeId is derived, not a raw eventId');
  });
});

// ---------------------------------------------------------------------------
// Part 2 — escalation accounting uses episodeCount (verdict R1/R2/R3)
// ---------------------------------------------------------------------------

describe('checkGuardThreshold — episode-based 3-per-7d accounting', () => {
  it('R1: four 429s in one 7s episode do NOT trigger (raw=4, episode=1)', async () => {
    const burst = verdictBurst();
    const log = createFakeLogWithEvents(burst);
    const redis = createFakeRedis();
    const triggerEval = mock.fn(async () => triggerSuccess());

    // Check fires on the 4th (latest) event of the burst.
    const result = await checkGuardThreshold(burst[3], { redis, guardRejectionLog: log, triggerEval });

    assert.equal(result.rawEventCount, 4, 'rawEventCount preserved in result');
    assert.equal(result.episodeCount, 1, 'burst counts as one episode');
    assert.equal(result.thresholdMet, false, 'one episode < 3 → threshold NOT met');
    assert.equal(result.escalated, false);
    assert.equal(triggerEval.mock.callCount(), 0, 'burst alone must NOT invoke eval cat');
  });

  it('R2: three separated episodes still trigger', async () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 3_600_000, seq: 1 }),
      rawEvent({ timestamp: T + 7_200_000, seq: 2 }),
    ];
    const log = createFakeLogWithEvents(events);
    const redis = createFakeRedis();
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(events[2], { redis, guardRejectionLog: log, triggerEval });

    assert.equal(result.episodeCount, 3);
    assert.equal(result.thresholdMet, true, 'three separated episodes meet the threshold');
    assert.equal(result.escalated, true);
    assert.equal(triggerEval.mock.callCount(), 1);
  });

  it('R2 variant: episodes from different cats count as distinct incidents for the same guard', async () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0, catId: 'cat_a', threadId: 'th_a' }),
      rawEvent({ timestamp: T + 5000, seq: 1, catId: 'cat_b', threadId: 'th_b' }),
      rawEvent({ timestamp: T + 9000, seq: 2, catId: 'cat_c', threadId: 'th_c' }),
    ];
    const log = createFakeLogWithEvents(events);
    const redis = createFakeRedis();
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(events[2], { redis, guardRejectionLog: log, triggerEval });

    assert.equal(result.episodeCount, 3, 'distributed incidents are real distinct episodes');
    assert.equal(result.escalated, true);
  });

  it('R3: isolated A2A streak-4 block is independently attributable and does not trigger alone', async () => {
    // Window contains the hold_ball burst AND one isolated A2A block.
    const all = [...verdictBurst(), a2aBlockEvent({ timestamp: T + 3000 })];
    const log = createFakeLogWithEvents(all);
    const redis = createFakeRedis();
    const triggerEval = mock.fn(async () => triggerSuccess());

    // Escalation check for the A2A guard sees ONLY its own guard's events.
    const a2aResult = await checkGuardThreshold(all[4], { redis, guardRejectionLog: log, triggerEval });
    assert.equal(a2aResult.guardId, 'a2a_pingpong_block');
    assert.equal(a2aResult.rawEventCount, 1, 'A2A accounting unaffected by hold_ball burst');
    assert.equal(a2aResult.episodeCount, 1);
    assert.equal(a2aResult.escalated, false, 'single A2A episode must not trigger');

    // And the hold_ball check in the same window still sees episode=1 (R1).
    const hbResult = await checkGuardThreshold(all[3], { redis, guardRejectionLog: log, triggerEval });
    assert.equal(hbResult.episodeCount, 1);
    assert.equal(hbResult.escalated, false);
    assert.equal(triggerEval.mock.callCount(), 0, 'neither guard triggers from this window');
  });

  it('claim value records episodeCount alongside raw count', async () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0 }),
      rawEvent({ timestamp: T + 1000, seq: 1 }),
      rawEvent({ timestamp: T + 200_000, seq: 2 }),
      rawEvent({ timestamp: T + 400_000, seq: 3 }),
    ];
    const log = createFakeLogWithEvents(events);
    const redis = createFakeRedis();
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(events[3], { redis, guardRejectionLog: log, triggerEval });
    assert.equal(result.rawEventCount, 4);
    assert.equal(result.episodeCount, 3, '2-event burst + 2 separated = 3 episodes');
    assert.equal(result.escalated, true);

    const stored = JSON.parse(redis._store.get('guard-rejection:escalated:hold_ball_rate_limit'));
    assert.equal(stored.episodeCount, 3, 'dedup claim carries episodeCount (incident semantics)');
  });
});

// ---------------------------------------------------------------------------
// Part 3 — snapshot & committed bundle carry episode + anchor metadata
// (PR #41: "bundle itself cannot independently recheck the 7.044s claim")
// ---------------------------------------------------------------------------

describe('snapshot provider — per-guard episode metadata', () => {
  it('byGuard aggregates carry rawEventCount + episodeCount + episodes with anchors', async () => {
    // Provider windows on Date.now() — place the burst just inside the window.
    const base = Date.now() - 60_000;
    const all = [...verdictBurst(base), a2aBlockEvent({ timestamp: base + 3000 })];
    const log = createFakeLogWithEvents(all);
    const root = mkdtempSync(join(tmpdir(), 'f257-episode-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog: log,
      harnessFeedbackRoot: root,
    });

    const hb = result.snapshot.byGuard.hold_ball_rate_limit;
    assert.equal(hb.count, 4, 'raw count preserved');
    assert.equal(hb.episodeCount, 1, 'burst = one episode');
    assert.ok(Array.isArray(hb.episodes) && hb.episodes.length === 1, 'episode metadata present');
    assert.equal(hb.episodes[0].rawEventCount, 4);
    assert.ok(hb.episodes[0].sampleAnchors.length > 0, 'episode anchors present (timestamps for recheck)');

    const a2a = result.snapshot.byGuard.a2a_pingpong_block;
    assert.equal(a2a.count, 1);
    assert.equal(a2a.episodeCount, 1);

    // Persisted file matches in-memory snapshot (KD-17 single source).
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.deepEqual(persisted.byGuard, result.snapshot.byGuard);
  });
});

describe('generator adapter — committed bundle provenance (PR #41 gap)', () => {
  it('bundle snapshot.json carries sampleAnchors + per-guard raw/episode counts + episode metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f257-bundle-'));
    const evalRunId = 'hlr-1700000000000-abcd1234';
    const windowStartMs = T - 1000;
    const windowEndMs = T + 100_000;

    // Stored run snapshot in the NEW schema (provider output shape).
    const storedSnapshot = {
      evalRunId,
      producedAt: new Date(T).toISOString(),
      window: { startMs: windowStartMs, endMs: windowEndMs, durationHours: 168 },
      totalEvents: 4,
      byKind: { http_rate_limit: 4 },
      byGuard: {
        hold_ball_rate_limit: {
          count: 4,
          kinds: ['http_rate_limit'],
          episodeCount: 1,
          episodes: [
            {
              episodeId: 'ep-test0000000001',
              startMs: T,
              endMs: T + 7044,
              rawEventCount: 4,
              sampleAnchors: [
                { eventId: 'evt-1', kind: 'http_rate_limit', guardId: 'hold_ball_rate_limit', timestamp: T },
                { eventId: 'evt-4', kind: 'http_rate_limit', guardId: 'hold_ball_rate_limit', timestamp: T + 7044 },
              ],
            },
          ],
        },
      },
      sampleAnchors: [{ eventId: 'evt-1', kind: 'http_rate_limit', guardId: 'hold_ball_rate_limit', timestamp: T }],
      howCounted: 'zset-window-scan',
    };
    mkdirSync(join(root, 'run-snapshots'), { recursive: true });
    writeFileSync(join(root, 'run-snapshots', `${evalRunId}.json`), JSON.stringify(storedSnapshot));

    const generate = createHarnessLedgerGeneratorAdapter();
    const { bundleDir } = await generate(
      { id: 'test-verdict-episode-1', verdict: 'fix' },
      { kind: 'prompt-segments', windowStartMs, windowEndMs, evalRunId },
      { harnessFeedbackRoot: root, liveHarnessFeedbackRoot: root },
    );

    const bundle = JSON.parse(readFileSync(join(bundleDir, 'snapshot.json'), 'utf8'));

    assert.ok(Array.isArray(bundle.sampleAnchors), 'bundle must carry sample anchors (PR #41: anchors were dropped)');
    assert.equal(bundle.sampleAnchors.length, 1);
    assert.equal(bundle.sampleAnchors[0].eventId, 'evt-1');
    assert.ok(
      typeof bundle.sampleAnchors[0].timestamp === 'number',
      'anchor timestamps enable independent burst recheck',
    );

    const hb = bundle.byGuardEpisodes.hold_ball_rate_limit;
    assert.equal(hb.rawEventCount, 4, 'bundle preserves rawEventCount');
    assert.equal(hb.episodeCount, 1, 'bundle carries episodeCount (distinct incidents)');
    assert.equal(hb.episodes[0].rawEventCount, 4, 'bundle carries episode metadata');
    assert.equal(hb.episodes[0].endMs - hb.episodes[0].startMs, 7044, 'episode span independently recheckable');

    // Backward-compat: legacy count-only map remains for existing consumers.
    assert.equal(bundle.byGuard.hold_ball_rate_limit, 4);
  });
});
