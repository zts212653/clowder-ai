/**
 * F257 Phase D — buildVersionChain() unit tests.
 *
 * Red tests for review findings:
 *   P1-1: activeVersion computation wrong (contentVersion=1 maps to manifest v1)
 *   P1-2: eval judgment unconditionally attached to latest epoch
 *   P2-3: no direct tests existed
 *
 * Scenarios from reviewer (terra/codex):
 *   1. Create and activate V2 (first content override)
 *   2. V2 exists but V1 still active (after rollback)
 *   3. Rollback then re-create (V3)
 *   4. Old eval NOT attributed to new version
 *   5. segmentVersion preserved in judgment attachment
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Helper: create a minimal OverrideChangeEvent for tests
function makeEvent(partial) {
  return {
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    hookId: 'S1',
    workspaceId: 'default',
    source: 'operator',
    timestamp: 0,
    actorId: 'user1',
    ...partial,
  };
}

describe('buildVersionChain', () => {
  /** @type {typeof import('../dist/routes/segment-lifeline-chain.js').buildVersionChain} */
  let buildVersionChain;
  /** @type {typeof import('../dist/routes/segment-lifeline-chain.js').attributeGuardEventsToEpochs} */
  let attributeGuardEventsToEpochs;

  test('setup: import chain builder', async () => {
    const mod = await import('../dist/routes/segment-lifeline-chain.js');
    buildVersionChain = mod.buildVersionChain;
    attributeGuardEventsToEpochs = mod.attributeGuardEventsToEpochs;
    assert.ok(buildVersionChain, 'buildVersionChain exported');
    assert.ok(attributeGuardEventsToEpochs, 'attributeGuardEventsToEpochs exported');
  });

  // ── Baseline ─────────────────────────────────────────────────

  test('manifest-only segment produces single v1 epoch', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: null,
    });

    assert.equal(chain.length, 1);
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].origin, 'manifest');
    assert.equal(chain[0].isActive, true);
    assert.equal(chain[0].status, 'idle');
  });

  // ── P1-1 scenario 1: Create and activate V2 ─────────────────

  test('first content-set creates v2 epoch and marks it active', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: 1,
    });

    assert.equal(chain.length, 2, 'should have 2 epochs');
    // V1 = manifest baseline, NOT active
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].isActive, false, 'v1 should NOT be active when content override exists');
    // V2 = first override, IS active
    assert.equal(chain[1].version, 2);
    assert.equal(chain[1].isActive, true, 'v2 should be active when contentVersion=1');
  });

  // ── P1-1 scenario 2: V2 exists but V1 still active ──────────

  test('v2 exists but v1 is active after rollback', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: null, // rolled back → contentVersion cleared
    });

    assert.equal(chain.length, 2, 'rollback does not remove epoch');
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].isActive, true, 'v1 should be active after rollback');
    assert.equal(chain[1].version, 2);
    assert.equal(chain[1].isActive, false, 'v2 should NOT be active after rollback');
  });

  // ── P1-1 scenario 3: Rollback then re-create ────────────────

  test('rollback then new content-set → v3 active, not v2', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
        makeEvent({ action: 'content-set', timestamp: 3000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: 1, // contentVersion restarted after rollback+re-create
    });

    assert.equal(chain.length, 3, 'should have 3 epochs');
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].isActive, false);
    assert.equal(chain[1].version, 2);
    assert.equal(chain[1].isActive, false, 'v2 (old override) should NOT be active');
    assert.equal(chain[2].version, 3);
    assert.equal(chain[2].isActive, true, 'v3 (latest override) should be active');
  });

  // ── P1-2 scenario 4: Old eval NOT on new version ────────────

  test('eval judgment at t=500 is NOT attached to v2 created at t=1000', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'alive',
        injectionCount: 10,
        violationCount: 0,
        correlationConfidence: 'window',
        evaluatedAt: 500, // BEFORE v2 was created at t=1000
        runId: 'run1',
        segmentVersion: 1,
      },
      currentContentVersion: 1,
    });

    // Eval ran at t=500 when only v1 existed → should be on v1
    assert.ok(chain[0].eval, 'v1 should have eval data');
    assert.equal(chain[0].eval.verdict, 'alive');
    // V2 should NOT have eval data (it didn't exist when eval ran)
    assert.equal(chain[1].eval, null, 'v2 should NOT have eval (created after eval ran)');
  });

  test('eval judgment at t=1500 IS attached to v2 created at t=1000', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'dormant',
        injectionCount: 5,
        violationCount: 3,
        correlationConfidence: 'window',
        evaluatedAt: 1500, // AFTER v2 was created at t=1000
        runId: 'run2',
        // R8: segmentVersion=2 matches epoch v2 (pipeline stamps activeEpochVersion).
        // Pre-R8 this was 1, but R8 version-aware attribution would send it to v1.
        segmentVersion: 2,
      },
      currentContentVersion: 1,
    });

    // Eval ran at t=1500 when v2 was current → should be on v2
    assert.equal(chain[0].eval, null, 'v1 should NOT have eval');
    assert.ok(chain[1].eval, 'v2 should have eval data');
    assert.equal(chain[1].eval.verdict, 'dormant');
  });

  // ── Observation attachment ───────────────────────────────────

  test('observations are attached to correct epoch by timestamp', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [
        { timestamp: 500, version: null }, // before v2
        { timestamp: 800, version: null }, // before v2
        { timestamp: 1200, version: null }, // after v2
        { timestamp: 1500, version: null }, // after v2
      ],
      cachedJudgment: null,
      currentContentVersion: 1,
    });

    assert.equal(chain[0].tracing?.observationCount, 2, 'v1 should have 2 observations');
    assert.equal(chain[1].tracing?.observationCount, 2, 'v2 should have 2 observations');
  });

  test('observations with explicit contentVersion use timestamp, not version-number match (R2 P1-1)', async () => {
    // Scenario: first content-set creates epoch v2 (chain auto-increments from manifest v1=1).
    // HookRegistry records contentVersion=1 in traces.
    // Old bug: findEpochForObservation matched version=1 → manifest epoch v1 (WRONG).
    // Fix: timestamp-based matching → obs at t=1200 (after v2 created at t=1000) → epoch v2.
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [
        { timestamp: 500, version: 1 }, // before v2 — contentVersion=1, should go to v1 by timestamp
        { timestamp: 1200, version: 1 }, // after v2 — contentVersion=1, MUST go to v2 by timestamp (not v1!)
        { timestamp: 1500, version: 2 }, // after v2 — contentVersion=2 from second implicit trace
      ],
      cachedJudgment: null,
      currentContentVersion: 1,
    });

    assert.equal(chain[0].tracing?.observationCount, 1, 'v1 epoch should have 1 observation (t=500)');
    assert.equal(chain[1].tracing?.observationCount, 2, 'v2 epoch should have 2 observations (t=1200 + t=1500)');
  });

  test('activeVersion in chain derives from isActive epoch, not raw contentVersion', async () => {
    // First content-set: chain epoch v2, contentVersion=1. They must not be confused.
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: 1,
    });

    const activeEpoch = chain.find((e) => e.isActive);
    assert.ok(activeEpoch, 'should have an active epoch');
    assert.equal(activeEpoch.version, 2, 'active epoch should be v2 (not contentVersion=1)');
    assert.equal(activeEpoch.origin, 'user-create', 'active epoch should be user-created override');
  });

  // ── Rollback activation timeline (R3 P1-1) ──────────────────

  test('rollback → trace after rollback goes to v1, not v2 (R3 P1-1)', async () => {
    // Terra reproduction: content-set@1000 → rollback@2000 → trace@2100
    // Old bug: startedAt-based matching put trace@2100 on v2 (2100 >= 1000).
    // Fix: activation timeline tracks rollback → v1 active from t=2000.
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
      ],
      observations: [
        { timestamp: 500, version: null }, // v1 active (before content-set)
        { timestamp: 1500, version: null }, // v2 active (between content-set and rollback)
        { timestamp: 2100, version: 1 }, // v1 active (after rollback) — MUST go to v1!
        { timestamp: 3000, version: null }, // v1 active (after rollback)
      ],
      cachedJudgment: null,
      currentContentVersion: null, // rollback clears content version
    });

    assert.equal(chain.length, 2, 'should have v1 + v2 epochs');
    assert.equal(chain[0].tracing?.observationCount, 3, 'v1 should have 3 obs (t=500, t=2100, t=3000)');
    assert.equal(chain[1].tracing?.observationCount, 1, 'v2 should have 1 obs (t=1500 only)');
    assert.equal(chain[0].isActive, true, 'v1 should be active after rollback');
    assert.equal(chain[1].isActive, false, 'v2 should NOT be active after rollback');
  });

  test('rollback → eval after rollback goes to v1, not v2 (R3 P1-1)', async () => {
    // Eval runs at t=2500, after rollback at t=2000.
    // Must attach to v1 (active after rollback), not v2.
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'alive',
        injectionCount: 8,
        violationCount: 0,
        correlationConfidence: 'window',
        evaluatedAt: 2500, // after rollback
        runId: 'run-post-rollback',
        segmentVersion: null,
      },
      currentContentVersion: null,
    });

    assert.ok(chain[0].eval, 'v1 should have eval (eval ran while v1 active after rollback)');
    assert.equal(chain[0].eval.verdict, 'alive');
    assert.equal(chain[1].eval, null, 'v2 should NOT have eval');
  });

  test('content-set → rollback → content-set: activation timeline tracks re-creation', async () => {
    // v1 → v2@1000 → rollback@2000 → v3@3000
    // trace@2500 (between rollback and v3) → v1
    // trace@3500 (after v3) → v3
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
        makeEvent({ action: 'content-set', timestamp: 3000 }),
      ],
      observations: [
        { timestamp: 500, version: null }, // v1
        { timestamp: 1500, version: null }, // v2
        { timestamp: 2500, version: null }, // v1 (after rollback)
        { timestamp: 3500, version: null }, // v3
      ],
      cachedJudgment: null,
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3, 'should have v1, v2, v3');
    assert.equal(chain[0].tracing?.observationCount, 2, 'v1: t=500 + t=2500');
    assert.equal(chain[1].tracing?.observationCount, 1, 'v2: t=1500');
    assert.equal(chain[2].tracing?.observationCount, 1, 'v3: t=3500');
    assert.equal(chain[2].isActive, true, 'v3 should be active');
  });

  // ── content-clear + same-ms edge cases (R4 P1-1) ────────────

  test('content-clear reactivates manifest, trace goes to v1 (R4 P1-1)', async () => {
    // content-clear removes content override like rollback but is a distinct action.
    // Old bug: timeline only handled rollback, not content-clear.
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-clear', timestamp: 2000 }),
      ],
      observations: [
        { timestamp: 1500, version: null }, // v2 active
        { timestamp: 2500, version: null }, // v1 active (after content-clear)
      ],
      cachedJudgment: null,
      currentContentVersion: null,
    });

    assert.equal(chain[0].tracing?.observationCount, 1, 'v1 should have 1 obs (t=2500, after content-clear)');
    assert.equal(chain[1].tracing?.observationCount, 1, 'v2 should have 1 obs (t=1500)');
    assert.equal(chain[0].isActive, true, 'v1 should be active after content-clear');
  });

  test('content-clear: eval after clear goes to manifest (R4 P1-1)', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-clear', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'alive',
        injectionCount: 5,
        violationCount: 0,
        correlationConfidence: 'window',
        evaluatedAt: 2500,
        runId: 'run-post-clear',
        segmentVersion: null,
      },
      currentContentVersion: null,
    });

    assert.ok(chain[0].eval, 'v1 should have eval (after content-clear)');
    assert.equal(chain[1].eval, null, 'v2 should NOT have eval');
  });

  test('same-ms content-set events: each creates distinct epoch with correct activation (R4 P1-1)', async () => {
    // Two content-set at t=1000: v2 and v3.
    // Old bug: findIndex(startedAt===1000) always matched v2 for both.
    // Fix: single-pass reducer directly assigns epochIndex at creation.
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-set', timestamp: 1000 }),
      ],
      observations: [
        { timestamp: 500, version: null }, // v1
        { timestamp: 1200, version: null }, // v3 (latest of same-ms pair)
      ],
      cachedJudgment: null,
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3, 'should have v1, v2, v3');
    assert.equal(chain[0].tracing?.observationCount, 1, 'v1: t=500');
    // v2 activated at t=1000 but immediately superseded by v3 at t=1000
    assert.equal(chain[1].tracing, null, 'v2: no observations (immediately superseded)');
    assert.equal(chain[2].tracing?.observationCount, 1, 'v3: t=1200 (latest same-ms activation)');
    assert.equal(chain[2].isActive, true, 'v3 should be active');
  });

  test('same-ms rollback→content-set: events in correct order → trace goes to v2 (R5 P1-1)', async () => {
    // Simulates real ZSET output AFTER event ID format fix:
    // rollback (seq=0) sorts before content-set (seq=1) at same timestamp.
    // Physical order: content-set (create v2) → rollback → content-set (create v3)
    // After rollback+content-set at t=2000, v3 is active, trace@2500 → v3.
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
        makeEvent({ action: 'content-set', timestamp: 2000 }), // same ms, seq after rollback
      ],
      observations: [{ timestamp: 2500, version: null }],
      cachedJudgment: null,
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3, 'v1 + v2 + v3');
    // v3 was created at t=2000 (after rollback at t=2000), v3 is latest active
    assert.equal(chain[2].isActive, true, 'v3 should be active');
    assert.equal(chain[2].tracing?.observationCount, 1, 'trace@2500 should go to v3 (active after rollback+create)');
    assert.equal(chain[0].tracing, null, 'v1 should have no observations');
    assert.equal(chain[1].tracing, null, 'v2 should have no observations');
  });

  // ── Status derivation ────────────────────────────────────────

  test('epoch with observations derives tracing status', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [{ timestamp: 1000, version: null }],
      cachedJudgment: null,
      currentContentVersion: null,
    });

    assert.equal(chain[0].status, 'tracing');
  });

  test('alive verdict derives governance-pending status (eval triggers governance)', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'alive',
        injectionCount: 10,
        violationCount: 0,
        correlationConfidence: 'window',
        evaluatedAt: 500,
        runId: 'run1',
        segmentVersion: null,
      },
      currentContentVersion: null,
    });

    // alive verdict → governance=pending takes priority → governance-pending status
    assert.equal(chain[0].status, 'governance-pending');
  });

  test('retire-candidate verdict derives eval-reject status (no governance)', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'retire-candidate',
        injectionCount: 10,
        violationCount: 8,
        correlationConfidence: 'window',
        evaluatedAt: 500,
        runId: 'run1',
        segmentVersion: null,
      },
      currentContentVersion: null,
    });

    assert.equal(chain[0].status, 'eval-reject');
  });

  // ── Governance events ────────────────────────────────────────

  test('operator enable/disable events map to governance kinds (AF-5)', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'disable', source: 'operator', timestamp: 1000 }),
        makeEvent({ action: 'enable', source: 'operator', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: null,
    });

    assert.equal(chain[0].events.length, 2);
    assert.equal(chain[0].events[0].kind, 'governance-reject', 'operator disable = governance-reject');
    assert.equal(chain[0].events[1].kind, 'governance-approve', 'operator enable = governance-approve');
  });

  test('auto-eval enable/disable events map to eval kinds (AF-5)', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'disable', source: 'auto-eval', timestamp: 1000 }),
        makeEvent({ action: 'enable', source: 'auto-eval', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: null,
    });

    assert.equal(chain[0].events.length, 2);
    assert.equal(chain[0].events[0].kind, 'eval-reject', 'auto-eval disable = eval-reject');
    assert.equal(chain[0].events[1].kind, 'eval-pass', 'auto-eval enable = eval-pass');
  });

  // ── Multiple content versions ────────────────────────────────

  test('two content-set events create v1, v2, v3 with v3 active', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-set', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3);
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].isActive, false);
    assert.equal(chain[1].version, 2);
    assert.equal(chain[1].isActive, false);
    assert.equal(chain[2].version, 3);
    assert.equal(chain[2].isActive, true, 'v3 (latest content-set) should be active');
  });

  // ── P1-2: per-version eval history ──────────────────────────

  test('multiple judgments distributed across epochs by activation timeline', async () => {
    // v1 (manifest) → content-set@1000 (v2) → content-set@2000 (v3)
    // judgment1 at t=500 → v1, judgment2 at t=1500 → v2, judgment3 at t=2500 → v3
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-set', timestamp: 2000 }),
      ],
      observations: [],
      judgmentHistory: [
        {
          segmentId: 'S1',
          verdict: 'alive',
          injectionCount: 10,
          violationCount: 0,
          correlationConfidence: 'window',
          evaluatedAt: 500,
          runId: 'run1',
          segmentVersion: 1,
        },
        {
          segmentId: 'S1',
          verdict: 'dormant',
          injectionCount: 5,
          violationCount: 3,
          correlationConfidence: 'window',
          evaluatedAt: 1500,
          runId: 'run2',
          segmentVersion: null,
        },
        {
          segmentId: 'S1',
          verdict: 'retire-candidate',
          injectionCount: 0,
          violationCount: 7,
          correlationConfidence: 'strong',
          evaluatedAt: 2500,
          runId: 'run3',
          segmentVersion: null,
        },
      ],
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3);
    // v1 got judgment1 (alive at t=500)
    assert.ok(chain[0].eval, 'v1 should have eval');
    assert.equal(chain[0].eval.verdict, 'alive');
    assert.equal(chain[0].eval.evaluatedAt, 500);
    // v2 got judgment2 (dormant at t=1500)
    assert.ok(chain[1].eval, 'v2 should have eval');
    assert.equal(chain[1].eval.verdict, 'dormant');
    assert.equal(chain[1].eval.evaluatedAt, 1500);
    // v3 got judgment3 (retire-candidate at t=2500)
    assert.ok(chain[2].eval, 'v3 should have eval');
    assert.equal(chain[2].eval.verdict, 'retire-candidate');
    assert.equal(chain[2].eval.evaluatedAt, 2500);
  });

  test('latest judgment wins when multiple map to same epoch', async () => {
    // Two evals during v1 lifetime (no override events)
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      judgmentHistory: [
        {
          segmentId: 'S1',
          verdict: 'dormant',
          injectionCount: 3,
          violationCount: 2,
          correlationConfidence: 'window',
          evaluatedAt: 500,
          runId: 'run1',
          segmentVersion: 1,
        },
        {
          segmentId: 'S1',
          verdict: 'alive',
          injectionCount: 10,
          violationCount: 0,
          correlationConfidence: 'strong',
          evaluatedAt: 1000,
          runId: 'run2',
          segmentVersion: 1,
        },
      ],
      currentContentVersion: null,
    });

    assert.equal(chain.length, 1);
    // Latest judgment (alive at t=1000) wins
    assert.ok(chain[0].eval, 'v1 should have eval');
    assert.equal(chain[0].eval.verdict, 'alive');
    assert.equal(chain[0].eval.evaluatedAt, 1000);
  });

  // ── P1-3: version-activate event in chain ────────────────────

  test('version-activate switches active epoch back to earlier version (epochVersion)', async () => {
    // v1 → content-set@1000 (v2) → content-set@2000 (v3) → version-activate epochVersion=2 @3000
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-set', timestamp: 2000 }),
        makeEvent({ action: 'version-activate', timestamp: 3000, epochVersion: 2 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3);
    assert.equal(chain[0].isActive, false, 'v1 not active');
    assert.equal(chain[1].isActive, true, 'v2 should be active after version-activate');
    assert.equal(chain[2].isActive, false, 'v3 not active');
  });

  test('observation after version-activate goes to activated epoch (epochVersion)', async () => {
    // v1 → content-set@1000 (v2) → version-activate epochVersion=1 @2000 → observation@2500
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'version-activate', timestamp: 2000, epochVersion: 1 }),
      ],
      observations: [{ timestamp: 2500, version: null }],
      judgmentHistory: [],
      currentContentVersion: 1,
    });

    assert.equal(chain.length, 2);
    // Observation at t=2500 should go to v1 (activated at t=2000)
    assert.ok(chain[0].tracing, 'v1 should have tracing data');
    assert.equal(chain[0].tracing.observationCount, 1);
    assert.equal(chain[1].tracing, null, 'v2 should have no tracing');
  });

  test('epochVersion takes precedence over contentVersion in version-activate (R6 regression guard)', async () => {
    // R6 bug: contentVersion=1 collides with manifest epoch.version=1
    // epochVersion=2 correctly targets the first override epoch
    // This test uses BOTH fields — epochVersion must win
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-set', timestamp: 2000 }),
        // contentVersion=1 would match manifest (WRONG), epochVersion=2 matches first override (RIGHT)
        makeEvent({ action: 'version-activate', timestamp: 3000, contentVersion: 1, epochVersion: 2 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 1,
    });

    assert.equal(chain.length, 3);
    assert.equal(chain[0].isActive, false, 'v1 (manifest) should NOT be active — contentVersion=1 must not win');
    assert.equal(chain[1].isActive, true, 'v2 (first override) should be active via epochVersion=2');
    assert.equal(chain[2].isActive, false, 'v3 not active');
  });

  test('backward compat: contentVersion used when epochVersion absent (pre-R6 events)', async () => {
    // Pre-R6 events only have contentVersion. Chain builder falls back.
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        // No epochVersion — uses contentVersion=2 which matches epoch.version=2
        makeEvent({ action: 'version-activate', timestamp: 2000, contentVersion: 2 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 2);
    assert.equal(chain[0].isActive, false, 'v1 not active');
    assert.equal(chain[1].isActive, true, 'v2 active via contentVersion fallback');
  });

  // ── R8: epochVersion as truth source in chain builder ──────

  test('R8 P1-1: judgment with segmentVersion goes to matching epoch, not timeline (Red→Green)', async () => {
    // Two content-set events create v2 and v3 epochs.
    // Two judgments in the SAME eval window (same evaluatedAt) but different segmentVersion.
    // Without the fix, both fall to the same timeline-resolved epoch (v3, the last active).
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 2 }),
        makeEvent({ action: 'content-set', timestamp: 2000, epochVersion: 3 }),
      ],
      observations: [],
      judgmentHistory: [
        {
          segmentId: 'S1',
          verdict: 'alive',
          injectionCount: 5,
          violationCount: 0,
          correlationConfidence: 'window',
          evaluatedAt: 5000,
          runId: 'r1',
          segmentVersion: 2,
        },
        {
          segmentId: 'S1',
          verdict: 'unmeasurable',
          injectionCount: 0,
          violationCount: 0,
          correlationConfidence: 'window',
          evaluatedAt: 5000,
          runId: 'r1',
          segmentVersion: 3,
        },
      ],
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3, 'manifest + 2 overrides');
    const v2 = chain.find((e) => e.version === 2);
    const v3 = chain.find((e) => e.version === 3);
    assert.ok(v2, 'v2 epoch must exist');
    assert.ok(v3, 'v3 epoch must exist');
    assert.ok(v2.eval, 'v2 should have eval');
    assert.equal(v2.eval.verdict, 'alive', 'v2 gets its own verdict (alive)');
    assert.ok(v3.eval, 'v3 should have eval');
    assert.equal(v3.eval.verdict, 'unmeasurable', 'v3 gets its own verdict (unmeasurable)');
  });

  test('R8 P1-2: epochs use epochVersion from events, not incremental (Red→Green)', async () => {
    // Events arrive out of order: epochVersion 3 first, then 2
    // (concurrent write: B got epoch=3, wrote first; A got epoch=2, wrote second)
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 3 }),
        makeEvent({ action: 'content-set', timestamp: 2000, epochVersion: 2 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 1,
    });

    assert.equal(chain.length, 3);
    assert.equal(chain[0].version, 1, 'manifest epoch');
    assert.equal(chain[1].version, 3, 'first event epoch uses epochVersion=3');
    assert.equal(chain[2].version, 2, 'second event epoch uses epochVersion=2');
    // Last event's epoch should be active (A wrote last)
    assert.equal(chain[2].isActive, true, 'v2 is active (last write)');
    assert.equal(chain[1].isActive, false, 'v3 is NOT active');
  });

  test('R8 backward compat: events without epochVersion use incremental fallback', async () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-set', timestamp: 2000 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 2,
    });

    assert.equal(chain[1].version, 2, 'fallback: manifest(1) + 1');
    assert.equal(chain[2].version, 3, 'fallback: 2 + 1');
  });

  test('R8 version-activate finds epoch by real epochVersion (not incremental)', async () => {
    // Out-of-order epochs: v3 created first, then v2
    // version-activate targets v3 — must find it correctly
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 3 }),
        makeEvent({ action: 'content-set', timestamp: 2000, epochVersion: 2 }),
        makeEvent({ action: 'version-activate', timestamp: 3000, epochVersion: 3 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 1,
    });

    assert.equal(chain.length, 3);
    assert.equal(chain[1].isActive, true, 'v3 (epoch index 1) reactivated');
    assert.equal(chain[2].isActive, false, 'v2 not active');
  });

  // ── R9: events attach to ACTIVE epoch, not last-created ─────
  //
  // State transition table (lifecycle state machine):
  //   State: { epochs[], activeIdx }
  //   content-set:      event → epochs[activeIdx], create new, activeIdx = new
  //   version-activate: event → epochs[activeIdx], activeIdx = target
  //   rollback:         event → epochs[activeIdx], activeIdx = 0
  //   content-clear:    event → epochs[activeIdx], activeIdx = 0
  //   enable/disable:   event → epochs[activeIdx], no active change

  test('R9: disable after activate(v2) goes to v2, not v3 (Red→Green)', async () => {
    // v1 → content-set(v2) → content-set(v3) → activate(v2) → disable
    // disable should be on v2 (active), NOT v3 (last created)
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 2 }),
        makeEvent({ action: 'content-set', timestamp: 2000, epochVersion: 3 }),
        makeEvent({ action: 'version-activate', timestamp: 3000, epochVersion: 2 }),
        makeEvent({ action: 'disable', timestamp: 4000 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 1,
    });

    assert.equal(chain.length, 3);
    const v2 = chain.find((e) => e.version === 2);
    const v3 = chain.find((e) => e.version === 3);
    // activate event should be on v3 (was active when activate happened)
    const v3Events = v3.events.map((e) => e.kind);
    assert.ok(v3Events.includes('version-activate'), 'activate event on v3 (was active)');
    // disable event should be on v2 (active after activate)
    const v2Events = v2.events.map((e) => e.kind);
    assert.ok(v2Events.includes('governance-reject'), 'disable event on v2 (now active)');
    // v2 should be active
    assert.equal(v2.isActive, true);
  });

  test('R9: content-set after activate(v2) branches from v2 (Red→Green)', async () => {
    // v1 → content-set(v2) → content-set(v3) → activate(v2) → content-set(v4)
    // The v4 creation event should be on v2 ("v2 → v4"), not v3
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 2 }),
        makeEvent({ action: 'content-set', timestamp: 2000, epochVersion: 3 }),
        makeEvent({ action: 'version-activate', timestamp: 3000, epochVersion: 2 }),
        makeEvent({ action: 'content-set', timestamp: 4000, epochVersion: 4 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 1,
    });

    assert.equal(chain.length, 4);
    const v2 = chain.find((e) => e.version === 2);
    // v2 should have the "v2 → v4" creation event (it was active when content-set happened)
    const v2Details = v2.events.map((e) => e.detail);
    assert.ok(
      v2Details.some((d) => d.includes('v2') && d.includes('v4')),
      'v2 has "v2 → v4" event',
    );
    // v4 should be active (last content-set)
    const v4 = chain.find((e) => e.version === 4);
    assert.equal(v4.isActive, true, 'v4 is active');
  });

  test('R9: rollback event goes to active epoch, not last-created (Red→Green)', async () => {
    // v1 → content-set(v2) → content-set(v3) → activate(v2) → rollback
    // rollback event should be on v2 (active), not v3 (last created)
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000, epochVersion: 2 }),
        makeEvent({ action: 'content-set', timestamp: 2000, epochVersion: 3 }),
        makeEvent({ action: 'version-activate', timestamp: 3000, epochVersion: 2 }),
        makeEvent({ action: 'rollback', timestamp: 4000 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 1,
    });

    const v2 = chain.find((e) => e.version === 2);
    const v2Events = v2.events.map((e) => e.detail);
    assert.ok(
      v2Events.some((d) => d.includes('rolled back')),
      'rollback event on v2 (was active)',
    );
    // After rollback, manifest is active
    assert.equal(chain[0].isActive, true, 'v1 (manifest) active after rollback');
  });

  // ── R15: guard event attribution via activation timeline ─────

  test('R15: v1→v2→rollback(v1)→activate(v2) guard attribution regression', async () => {
    // Timeline: t=0 v1 active, t=100 v2 active, t=200 rollback→v1, t=300 activate→v2
    const { chain, timeline } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 100, epochVersion: 2 }),
        makeEvent({ action: 'rollback', timestamp: 200 }),
        makeEvent({ action: 'version-activate', timestamp: 300, epochVersion: 2 }),
      ],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 2,
    });
    const metrics = attributeGuardEventsToEpochs(chain, timeline, [
      { timestamp: 50, guardId: 'g1' }, // v1 active
      { timestamp: 150, guardId: 'g1' }, // v2 active
      { timestamp: 250, guardId: 'g1' }, // v1 active (post-rollback)
      { timestamp: 350, guardId: 'g1' }, // v2 active (re-activated)
    ]);
    assert.deepEqual(metrics[1], [{ guardId: 'g1', count: 2 }], 'v1 gets t=50+t=250');
    assert.deepEqual(metrics[2], [{ guardId: 'g1', count: 2 }], 'v2 gets t=150+t=350');
  });

  test('R15: per-guard grouping in attributed metrics', async () => {
    const { chain, timeline } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 100, epochVersion: 2 })],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: 2,
    });
    const metrics = attributeGuardEventsToEpochs(chain, timeline, [
      { timestamp: 150, guardId: 'g-alpha' },
      { timestamp: 160, guardId: 'g-beta' },
      { timestamp: 170, guardId: 'g-alpha' },
    ]);
    assert.deepEqual(metrics[1], [], 'v1 has no events');
    assert.equal(metrics[2].length, 2, 'v2 has 2 guard groups');
    assert.deepEqual(metrics[2][0], { guardId: 'g-alpha', count: 2 });
    assert.deepEqual(metrics[2][1], { guardId: 'g-beta', count: 1 });
  });

  test('R15: empty guard events yields empty arrays per epoch', async () => {
    const { chain, timeline } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      judgmentHistory: [],
      currentContentVersion: null,
    });
    const metrics = attributeGuardEventsToEpochs(chain, timeline, []);
    assert.deepEqual(metrics[1], []);
  });

  test('R15: buildVersionChain returns { chain, timeline }', async () => {
    const result = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      currentContentVersion: null,
    });
    assert.ok(Array.isArray(result.chain), 'chain is array');
    assert.ok(Array.isArray(result.timeline), 'timeline is array');
    assert.equal(result.chain.length, 1);
    assert.equal(result.timeline.length, 1);
  });

  test('rollback redistributes judgments: post-rollback eval goes to manifest', async () => {
    // v1 → content-set@1000 (v2) → rollback@2000 → eval@2500 → content-set@3000 (v3)
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
        makeEvent({ action: 'content-set', timestamp: 3000 }),
      ],
      observations: [],
      judgmentHistory: [
        {
          segmentId: 'S1',
          verdict: 'dormant',
          injectionCount: 5,
          violationCount: 3,
          correlationConfidence: 'window',
          evaluatedAt: 1500,
          runId: 'run1',
          segmentVersion: null,
        },
        {
          segmentId: 'S1',
          verdict: 'alive',
          injectionCount: 12,
          violationCount: 0,
          correlationConfidence: 'strong',
          evaluatedAt: 2500,
          runId: 'run2',
          segmentVersion: null,
        },
      ],
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3);
    // v1: eval@2500 (post-rollback, manifest active)
    assert.ok(chain[0].eval, 'v1 should have eval (post-rollback)');
    assert.equal(chain[0].eval.verdict, 'alive');
    assert.equal(chain[0].eval.evaluatedAt, 2500);
    // v2: eval@1500 (during v2 active period)
    assert.ok(chain[1].eval, 'v2 should have eval');
    assert.equal(chain[1].eval.verdict, 'dormant');
    assert.equal(chain[1].eval.evaluatedAt, 1500);
    // v3: no eval yet
    assert.equal(chain[2].eval, null, 'v3 has no eval yet');
  });
});
