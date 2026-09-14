/**
 * F257 V2 — skip-reason eligibility registry + escalation filter tests.
 *
 * Sol R2 fixes:
 * P1-1: truncation → always conservative-true (unscanned tail may be eligible)
 * P1-2: byReason null-prototype (prototype pollution prevention)
 * P2-1: producer exhaustiveness (queue_pending removed from union, satisfies)
 * P2-2: committed bundle/provenance tests via generator adapter
 * P2-3: real append→hook integration test
 *
 * Sol R3 fixes:
 * P1-1: claim lifecycle — uncertainty_probe (1h) vs confirmed (7d) separation;
 *        truncation-only claims don't suppress subsequent real harm
 * P2-1: synthetic pingpong_streak reason bound to producer type
 *
 * [宪宪/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import {
  checkGuardThreshold,
  createThresholdEscalationHook,
} from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';
import { produceHarnessLedgerRunSnapshot } from '../../dist/infrastructure/harness-eval/harness-ledger-snapshot-provider.js';
import {
  isEscalationEligible,
  SKIP_REASON_ELIGIBILITY,
  skipReasonCategory,
} from '../../dist/infrastructure/harness-eval/skip-reason-eligibility.js';
import { createFakeEventSource, rawEvent, T, triggerSuccess } from './_guard-test-helpers.js';

// ---------------------------------------------------------------------------
// 1. Registry unit tests (P2-2 classifications + P3-1 deep freeze)
// ---------------------------------------------------------------------------

describe('skip-reason eligibility registry', () => {
  it('dedup_active is NOT eligible for escalation', () => {
    assert.equal(isEscalationEligible('dedup_active'), false);
  });

  it('aborted is NOT eligible for escalation', () => {
    assert.equal(isEscalationEligible('aborted'), false);
  });

  it('depth IS eligible for escalation (chain safety guard)', () => {
    assert.equal(isEscalationEligible('depth'), true);
  });

  it('pingpong_streak IS eligible for escalation', () => {
    assert.equal(isEscalationEligible('pingpong_streak'), true);
  });

  it('unknown reason defaults to eligible (fail-closed)', () => {
    assert.equal(isEscalationEligible('some_future_reason'), true);
  });

  it('undefined/missing reason defaults to eligible (fail-closed)', () => {
    assert.equal(isEscalationEligible(undefined), true);
  });

  it('empty string defaults to eligible (fail-closed)', () => {
    assert.equal(isEscalationEligible(''), true);
  });

  it('queue_pending is NOT registered (dead letter — no production emit point)', () => {
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, 'queue_pending'), false);
    // Falls through to unknown → eligible (fail-closed)
    assert.equal(isEscalationEligible('queue_pending'), true);
  });

  it('prototype keys are not eligible entries', () => {
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, 'toString'), false);
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, 'constructor'), false);
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, '__proto__'), false);
  });

  // P3-1: deep freeze
  it('entries are deeply frozen (sol R1 P3-1)', () => {
    const entry = SKIP_REASON_ELIGIBILITY.dedup_active;
    assert.ok(Object.isFrozen(entry), 'entry object must be frozen');
    assert.throws(
      () => {
        /** @type {any} */ (entry).eligible = true;
      },
      TypeError,
      'mutating frozen entry must throw in strict mode',
    );
  });
});

describe('skipReasonCategory (P2-2 producer semantics)', () => {
  it('dedup_active → delivery_dedup', () => {
    assert.equal(skipReasonCategory('dedup_active'), 'delivery_dedup');
  });

  it('depth → safety_guard (chain safety limit, not capacity)', () => {
    assert.equal(skipReasonCategory('depth'), 'safety_guard');
  });

  it('pingpong_streak → safety_guard', () => {
    assert.equal(skipReasonCategory('pingpong_streak'), 'safety_guard');
  });

  it('aborted → abort', () => {
    assert.equal(skipReasonCategory('aborted'), 'abort');
  });

  it('unknown → unknown', () => {
    assert.equal(skipReasonCategory('mystery_reason'), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// 2. Escalation integration — current event IN log (production parity)
// ---------------------------------------------------------------------------

describe('escalation eligibility filter — dedup_active (sol verdict, real append)', () => {
  it('3 dedup_active events in log do NOT trigger escalation', async () => {
    // P2-3: current event IS in the seeded log (production: append writes
    // to ZSET, then postAppendHook fires with the same event).
    const currentEvent = rawEvent({
      timestamp: T + 240_000,
      seq: 2,
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'dedup_active',
    });
    const events = [
      rawEvent({
        timestamp: T,
        seq: 0,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, false, 'dedup_active must NOT meet threshold');
    assert.equal(result.escalated, false, 'must NOT escalate');
    assert.equal(result.episodeCount, 0, 'eligible episode count must be 0');
    assert.equal(triggerEval.mock.callCount(), 0, 'triggerEval must NOT be called');
  });

  it('3 eligible (depth) events in log DO trigger escalation', async () => {
    const currentEvent = rawEvent({
      timestamp: T + 240_000,
      seq: 2,
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'depth',
    });
    const events = [
      rawEvent({
        timestamp: T,
        seq: 0,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, true, 'eligible events must meet threshold');
    assert.equal(result.escalationKind, 'confirmed', 'episodeCount >= threshold → confirmed');
    assert.equal(result.escalated, true, 'must escalate');
    assert.equal(triggerEval.mock.callCount(), 1, 'triggerEval must be called once');
    // Sol R5 P2: seam-level — verify escalationKind actually reaches triggerEval args
    const triggerArgs = triggerEval.mock.calls[0].arguments[0];
    assert.equal(triggerArgs.escalationKind, 'confirmed', 'triggerEval receives confirmed escalationKind');
  });

  it('mixed: 5 dedup_active + 3 eligible (in log) → DOES escalate', async () => {
    const currentEvent = rawEvent({
      timestamp: T + 840_000,
      seq: 7,
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'depth',
    });
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'a2a_route_decision_skip', normalizedReason: 'dedup_active' }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 240_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 360_000,
        seq: 3,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 480_000,
        seq: 4,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({ timestamp: T + 600_000, seq: 5, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      rawEvent({ timestamp: T + 720_000, seq: 6, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, true, '3 eligible episodes (depth) meet threshold');
    assert.equal(result.escalationKind, 'confirmed', 'episodeCount >= threshold → confirmed');
    assert.equal(result.escalated, true, 'must escalate');
    assert.equal(triggerEval.mock.callCount(), 1);
  });

  it('mixed: 5 dedup_active + 2 eligible (in log) → does NOT escalate', async () => {
    const currentEvent = rawEvent({
      timestamp: T + 720_000,
      seq: 6,
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'depth',
    });
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'a2a_route_decision_skip', normalizedReason: 'dedup_active' }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 240_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 360_000,
        seq: 3,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 480_000,
        seq: 4,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({ timestamp: T + 600_000, seq: 5, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.episodeCount, 2, 'only 2 eligible episodes');
    assert.equal(result.thresholdMet, false, 'below threshold');
    assert.equal(result.escalated, false);
    assert.equal(triggerEval.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Hard-cap three-state (sol R2 P1-1: truncation = always conservative-true)
// ---------------------------------------------------------------------------

describe('hard-cap + eligibility filter (sol R2 P1-1)', () => {
  it('10,001 dedup_active events hitting hard cap DO escalate (conservative-true)', async () => {
    // Sol R2 P1-1: truncation means unscanned tail may contain eligible events.
    // Conservative-true: false positive (one eval run) is bounded and acceptable;
    // eval cat sees all-dedup_active byReason and correctly self-determines.
    const events = Array.from({ length: 10_001 }, (_, i) =>
      rawEvent({
        timestamp: T + i,
        seq: i,
        eventId: `dedup-cap-${i}`,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(events[events.length - 1], {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.truncated, true, 'hard cap hit');
    assert.equal(result.thresholdMet, true, 'truncated → conservative-true (unscanned tail may be eligible)');
    assert.equal(result.escalationKind, 'uncertainty_probe', 'truncation-only → uncertainty_probe (Fable ruling)');
    assert.equal(result.escalated, true, 'must escalate (eval cat has byReason to self-determine)');
  });

  it('10,001 eligible events hitting hard cap DO escalate', async () => {
    const events = Array.from({ length: 10_001 }, (_, i) =>
      rawEvent({
        timestamp: T + i,
        seq: i,
        eventId: `elig-cap-${i}`,
        guardId: 'hold_ball_rate_limit',
      }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(events[events.length - 1], {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.truncated, true, 'hard cap hit');
    assert.equal(result.thresholdMet, true, 'eligible cap → conservative-true');
    assert.equal(result.escalationKind, 'uncertainty_probe', 'cap with episodeCount < threshold → uncertainty_probe');
    assert.equal(result.escalated, true, 'must escalate');
  });

  it('mixed at cap: 10k dedup_active + 3 depth (in tail) → conservative-true', async () => {
    // Sol R2 P1-1: the key scenario — cap cuts scan before reaching the
    // eligible tail. Conservative-true ensures these 3 depth events don't
    // silently become a false negative.
    const events = [
      ...Array.from({ length: 10_000 }, (_, i) =>
        rawEvent({
          timestamp: T + i,
          seq: i,
          eventId: `dedup-mixed-${i}`,
          guardId: 'a2a_route_decision_skip',
          normalizedReason: 'dedup_active',
        }),
      ),
      // These 3 depth events are in the log but beyond the hard cap scan boundary
      rawEvent({
        timestamp: T + 120_000,
        seq: 10000,
        eventId: 'depth-tail-0',
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      rawEvent({
        timestamp: T + 240_000,
        seq: 10001,
        eventId: 'depth-tail-1',
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      rawEvent({
        timestamp: T + 360_000,
        seq: 10002,
        eventId: 'depth-tail-2',
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(events[events.length - 1], {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.truncated, true, 'hard cap hit');
    assert.equal(result.thresholdMet, true, 'conservative-true: unscanned tail has eligible events');
    assert.equal(result.escalationKind, 'uncertainty_probe', 'truncation before threshold → uncertainty_probe');
    assert.equal(result.escalated, true, 'must escalate — false negative here would be a safety gap');
  });
});

// ---------------------------------------------------------------------------
// 4. Non-regression: hold_ball and pingpong still escalate
// ---------------------------------------------------------------------------

describe('escalation non-regression — hold_ball and pingpong', () => {
  it('hold_ball_rate_limit events still escalate', async () => {
    const currentEvent = rawEvent({ timestamp: T + 240_000, seq: 2, guardId: 'hold_ball_rate_limit' });
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'hold_ball_rate_limit' }),
      rawEvent({ timestamp: T + 120_000, seq: 1, guardId: 'hold_ball_rate_limit' }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, true, 'hold_ball must still meet threshold');
    assert.equal(result.escalationKind, 'confirmed', 'hold_ball 3 episodes → confirmed');
    assert.equal(result.escalated, true, 'hold_ball must still escalate');
  });

  it('a2a_block_pingpong events still escalate', async () => {
    const currentEvent = rawEvent({
      timestamp: T + 240_000,
      seq: 2,
      guardId: 'a2a_block_pingpong',
      normalizedReason: 'pingpong_streak',
    });
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'a2a_block_pingpong', normalizedReason: 'pingpong_streak' }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_block_pingpong',
        normalizedReason: 'pingpong_streak',
      }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, true, 'pingpong must still meet threshold');
    assert.equal(result.escalationKind, 'confirmed', 'pingpong 3 episodes → confirmed');
    assert.equal(result.escalated, true, 'pingpong must still escalate');
  });
});

// ---------------------------------------------------------------------------
// 5. Snapshot byReason + sourceThreadId (P2-1 provenance)
// ---------------------------------------------------------------------------

describe('snapshot byReason breakdown (sol R1 P2-1)', () => {
  const NOW = Date.now();

  it('snapshot includes per-reason count, category, and eligibility', async () => {
    const events = [
      rawEvent({
        timestamp: NOW - 3000,
        seq: 0,
        normalizedReason: 'dedup_active',
        guardId: 'a2a_route_decision_skip',
      }),
      rawEvent({
        timestamp: NOW - 2000,
        seq: 1,
        normalizedReason: 'dedup_active',
        guardId: 'a2a_route_decision_skip',
      }),
      rawEvent({ timestamp: NOW - 1000, seq: 2, normalizedReason: 'depth', guardId: 'a2a_route_decision_skip' }),
    ];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-byreason-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
    });

    assert.ok(result.snapshot.byReason, 'byReason must be present');
    assert.equal(result.snapshot.byReason.dedup_active.count, 2);
    assert.equal(result.snapshot.byReason.dedup_active.eligible, false);
    assert.equal(result.snapshot.byReason.dedup_active.category, 'delivery_dedup');
    assert.equal(result.snapshot.byReason.depth.count, 1);
    assert.equal(result.snapshot.byReason.depth.eligible, true);
    assert.equal(result.snapshot.byReason.depth.category, 'safety_guard');

    // Persisted JSON round-trip: null-prototype → regular object after parse,
    // so compare individual entries (deepStrictEqual checks prototype chain).
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.equal(persisted.byReason.dedup_active.count, 2, 'persisted dedup_active count');
    assert.equal(persisted.byReason.dedup_active.eligible, false, 'persisted dedup_active eligible');
    assert.equal(persisted.byReason.depth.count, 1, 'persisted depth count');
    assert.equal(persisted.byReason.depth.eligible, true, 'persisted depth eligible');
  });

  it('sourceThreadId persisted in snapshot when provided', async () => {
    const events = [rawEvent({ timestamp: NOW - 1000, seq: 0 })];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-srcthread-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
      sourceThreadId: 'thread_abc123',
    });

    assert.equal(result.snapshot.sourceThreadId, 'thread_abc123');
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.equal(persisted.sourceThreadId, 'thread_abc123', 'persisted sourceThreadId');
  });

  it('sourceThreadId absent when not provided (scheduled trigger)', async () => {
    const events = [rawEvent({ timestamp: NOW - 1000, seq: 0 })];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-nosrc-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
    });

    assert.equal(result.snapshot.sourceThreadId, undefined);
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.equal(persisted.sourceThreadId, undefined, 'no sourceThreadId in persisted');
  });

  // Sol R4 P1-1: escalationKind propagation through snapshot
  it('escalationKind persisted in snapshot when provided (uncertainty_probe)', async () => {
    const events = [rawEvent({ timestamp: NOW - 1000, seq: 0 })];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-escKind-probe-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
      escalationKind: 'uncertainty_probe',
    });

    assert.equal(result.snapshot.escalationKind, 'uncertainty_probe');
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.equal(persisted.escalationKind, 'uncertainty_probe', 'persisted escalationKind');
  });

  it('escalationKind persisted in snapshot when provided (confirmed)', async () => {
    const events = [rawEvent({ timestamp: NOW - 1000, seq: 0 })];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-escKind-confirmed-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
      escalationKind: 'confirmed',
    });

    assert.equal(result.snapshot.escalationKind, 'confirmed');
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.equal(persisted.escalationKind, 'confirmed', 'persisted escalationKind');
  });

  it('escalationKind absent when not provided (manual/scheduled trigger)', async () => {
    const events = [rawEvent({ timestamp: NOW - 1000, seq: 0 })];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-escKind-absent-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
    });

    assert.equal(result.snapshot.escalationKind, undefined);
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.equal(persisted.escalationKind, undefined, 'no escalationKind in persisted');
  });

  it('uncertainty_probe summary includes UNCERTAINTY PROBE warning', async () => {
    const events = [rawEvent({ timestamp: NOW - 1000, seq: 0 })];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-escKind-summary-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
      escalationKind: 'uncertainty_probe',
    });

    assert.ok(result.summary.includes('UNCERTAINTY PROBE'), 'summary includes uncertainty probe warning');
    assert.ok(result.summary.includes('truncation'), 'summary mentions truncation cause');
  });

  // Sol R2 P1-2: prototype pollution regression
  it('byReason aggregation is prototype-safe (__proto__ / constructor / toString)', async () => {
    const events = [
      rawEvent({ timestamp: NOW - 3000, seq: 0, normalizedReason: '__proto__', guardId: 'a2a_route_decision_skip' }),
      rawEvent({ timestamp: NOW - 2000, seq: 1, normalizedReason: 'constructor', guardId: 'a2a_route_decision_skip' }),
      rawEvent({ timestamp: NOW - 1000, seq: 2, normalizedReason: 'toString', guardId: 'a2a_route_decision_skip' }),
    ];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-proto-'));

    // Before fix: byReason['__proto__'] would pollute Object.prototype
    const savedProtoCount = Object.prototype.count;
    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
    });

    // Verify no prototype pollution
    assert.equal(Object.prototype.count, savedProtoCount, 'Object.prototype.count must NOT be polluted');

    // Verify the entries are correctly stored as own properties.
    // Use Object.hasOwn + direct access to avoid biome's useLiteralKeys
    // on __proto__ (dot-access would invoke the prototype getter).
    const br = result.snapshot.byReason;
    assert.ok(br, 'byReason must be present');
    assert.ok(Object.hasOwn(br, '__proto__'), '__proto__ is own property');
    assert.equal(Reflect.get(br, '__proto__')?.count, 1, '__proto__ reason stored as own property');
    assert.ok(Object.hasOwn(br, 'constructor'), 'constructor is own property');
    assert.equal(Reflect.get(br, 'constructor')?.count, 1, 'constructor reason stored');
    assert.ok(Object.hasOwn(br, 'toString'), 'toString is own property');
    assert.equal(Reflect.get(br, 'toString')?.count, 1, 'toString reason stored');

    // Verify JSON round-trip preserves all entries
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.ok(Object.hasOwn(persisted.byReason, '__proto__'), '__proto__ survives JSON round-trip');
    assert.equal(Reflect.get(persisted.byReason, '__proto__')?.count, 1, '__proto__ count round-trip');
    assert.equal(Reflect.get(persisted.byReason, 'constructor')?.count, 1, 'constructor count round-trip');
  });
});

// ---------------------------------------------------------------------------
// 6. Sol R2 P2-2: committed bundle/provenance via generator adapter
// ---------------------------------------------------------------------------

describe('committed bundle carries byReason + sourceThreadId (sol R2 P2-2)', () => {
  const DEFAULT_WINDOW_START = 1700000000000;
  const DEFAULT_WINDOW_END = 1700604800000;
  let evalRunCounter = 100;

  function safeEvalRunId() {
    return `hlr-${1700000000000 + evalRunCounter++}-a1b2c3d4`;
  }

  function writeSnapshotFile(rootDir, evalRunId, overrides = {}) {
    const dir = join(rootDir, 'run-snapshots');
    mkdirSync(dir, { recursive: true });
    const snapshot = {
      evalRunId,
      producedAt: new Date().toISOString(),
      ownerUserId: 'user_1',
      window: { startMs: DEFAULT_WINDOW_START, endMs: DEFAULT_WINDOW_END, durationHours: 168 },
      totalEvents: 3,
      byKind: { route_decision_skip: 3 },
      byGuard: { a2a_route_decision_skip: { count: 3, kinds: ['route_decision_skip'], episodeCount: 1, episodes: [] } },
      sampleAnchors: [],
      howCounted: 'zset-window-scan',
      truncated: false,
      ...overrides,
    };
    writeFileSync(join(dir, `${evalRunId}.json`), JSON.stringify(snapshot, null, 2));
    return snapshot;
  }

  it('bundle snapshot.json carries byReason from stored snapshot', async () => {
    const { createHarnessLedgerGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = mkdtempSync(join(tmpdir(), 'f257-bundle-byreason-'));
    const evalRunId = safeEvalRunId();
    const packet = { id: 'byreason-bundle-test', domainId: 'eval:harness-ledger' };

    writeSnapshotFile(tmpDir, evalRunId, {
      byReason: {
        dedup_active: { count: 2, category: 'delivery_dedup', eligible: false },
        depth: { count: 1, category: 'safety_guard', eligible: true },
      },
    });

    const result = await generator(
      packet,
      { kind: 'prompt-segments', windowStartMs: DEFAULT_WINDOW_START, windowEndMs: DEFAULT_WINDOW_END, evalRunId },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir, ownerUserId: 'user_1' },
    );

    const bundleSnapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.ok(bundleSnapshot.byReason, 'bundle snapshot must contain byReason');
    assert.equal(bundleSnapshot.byReason.dedup_active.count, 2);
    assert.equal(bundleSnapshot.byReason.dedup_active.eligible, false);
    assert.equal(bundleSnapshot.byReason.depth.count, 1);
    assert.equal(bundleSnapshot.byReason.depth.eligible, true);
  });

  it('bundle snapshot.json omits byReason when not in stored snapshot (backward compat)', async () => {
    const { createHarnessLedgerGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = mkdtempSync(join(tmpdir(), 'f257-bundle-nobyreason-'));
    const evalRunId = safeEvalRunId();
    const packet = { id: 'nobyreason-bundle-test', domainId: 'eval:harness-ledger' };

    // No byReason in stored snapshot — pre-classification snapshots
    writeSnapshotFile(tmpDir, evalRunId);

    const result = await generator(
      packet,
      { kind: 'prompt-segments', windowStartMs: DEFAULT_WINDOW_START, windowEndMs: DEFAULT_WINDOW_END, evalRunId },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir, ownerUserId: 'user_1' },
    );

    const bundleSnapshot = JSON.parse(readFileSync(join(result.bundleDir, 'snapshot.json'), 'utf8'));
    assert.equal(bundleSnapshot.byReason, undefined, 'byReason absent when not in stored snapshot');
  });

  it('provenance.json carries sourceThreadId from stored snapshot', async () => {
    const { createHarnessLedgerGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = mkdtempSync(join(tmpdir(), 'f257-prov-srcthread-'));
    const evalRunId = safeEvalRunId();
    const packet = { id: 'srcthread-prov-test', domainId: 'eval:harness-ledger' };

    writeSnapshotFile(tmpDir, evalRunId, { sourceThreadId: 'thread_xyz789' });

    const result = await generator(
      packet,
      { kind: 'prompt-segments', windowStartMs: DEFAULT_WINDOW_START, windowEndMs: DEFAULT_WINDOW_END, evalRunId },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir, ownerUserId: 'user_1' },
    );

    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.producedBy.runId, evalRunId);
    assert.equal(provenance.producedBy.sourceThreadId, 'thread_xyz789', 'sourceThreadId in provenance');
  });

  it('provenance.json omits sourceThreadId when absent (scheduled trigger)', async () => {
    const { createHarnessLedgerGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = mkdtempSync(join(tmpdir(), 'f257-prov-nosrcthread-'));
    const evalRunId = safeEvalRunId();
    const packet = { id: 'nosrcthread-prov-test', domainId: 'eval:harness-ledger' };

    // No sourceThreadId in stored snapshot
    writeSnapshotFile(tmpDir, evalRunId);

    const result = await generator(
      packet,
      { kind: 'prompt-segments', windowStartMs: DEFAULT_WINDOW_START, windowEndMs: DEFAULT_WINDOW_END, evalRunId },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir, ownerUserId: 'user_1' },
    );

    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.producedBy.runId, evalRunId);
    assert.equal(provenance.producedBy.sourceThreadId, undefined, 'no sourceThreadId when absent');
  });

  // Sol R4 P1-1: escalationKind propagation through bundle provenance
  it('provenance.json carries escalationKind from stored snapshot (uncertainty_probe)', async () => {
    const { createHarnessLedgerGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = mkdtempSync(join(tmpdir(), 'f257-prov-escKind-probe-'));
    const evalRunId = safeEvalRunId();
    const packet = { id: 'escKind-probe-prov-test', domainId: 'eval:harness-ledger' };

    writeSnapshotFile(tmpDir, evalRunId, { escalationKind: 'uncertainty_probe' });

    const result = await generator(
      packet,
      { kind: 'prompt-segments', windowStartMs: DEFAULT_WINDOW_START, windowEndMs: DEFAULT_WINDOW_END, evalRunId },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir, ownerUserId: 'user_1' },
    );

    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.producedBy.runId, evalRunId);
    assert.equal(provenance.producedBy.escalationKind, 'uncertainty_probe', 'escalationKind in provenance');
  });

  it('provenance.json carries escalationKind from stored snapshot (confirmed)', async () => {
    const { createHarnessLedgerGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = mkdtempSync(join(tmpdir(), 'f257-prov-escKind-confirmed-'));
    const evalRunId = safeEvalRunId();
    const packet = { id: 'escKind-confirmed-prov-test', domainId: 'eval:harness-ledger' };

    writeSnapshotFile(tmpDir, evalRunId, { escalationKind: 'confirmed' });

    const result = await generator(
      packet,
      { kind: 'prompt-segments', windowStartMs: DEFAULT_WINDOW_START, windowEndMs: DEFAULT_WINDOW_END, evalRunId },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir, ownerUserId: 'user_1' },
    );

    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.producedBy.runId, evalRunId);
    assert.equal(provenance.producedBy.escalationKind, 'confirmed', 'escalationKind in provenance');
  });

  it('provenance.json omits escalationKind when absent (manual/scheduled trigger)', async () => {
    const { createHarnessLedgerGeneratorAdapter } = await import(
      '../../dist/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.js'
    );
    const generator = createHarnessLedgerGeneratorAdapter();
    const tmpDir = mkdtempSync(join(tmpdir(), 'f257-prov-noEscKind-'));
    const evalRunId = safeEvalRunId();
    const packet = { id: 'noEscKind-prov-test', domainId: 'eval:harness-ledger' };

    // No escalationKind in stored snapshot
    writeSnapshotFile(tmpDir, evalRunId);

    const result = await generator(
      packet,
      { kind: 'prompt-segments', windowStartMs: DEFAULT_WINDOW_START, windowEndMs: DEFAULT_WINDOW_END, evalRunId },
      { harnessFeedbackRoot: tmpDir, liveHarnessFeedbackRoot: tmpDir, ownerUserId: 'user_1' },
    );

    const provenance = JSON.parse(readFileSync(join(result.bundleDir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.producedBy.runId, evalRunId);
    assert.equal(provenance.producedBy.escalationKind, undefined, 'no escalationKind when absent');
  });
});

// ---------------------------------------------------------------------------
// 7. Sol R2 P2-3: real append → postAppendHook integration
// ---------------------------------------------------------------------------

describe('real append → hook with eligibility filter (sol R2 P2-3)', async () => {
  const { GuardRejectionEventLog } = await import('../../dist/infrastructure/harness-eval/GuardRejectionEventLog.js');

  /** Full fake Redis supporting both ZSET (event log) and KV (dedup claim). */
  function createFullFakeRedis() {
    const store = new Map();
    const sorted = new Map();
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
      zadd: async (key, score, member) => {
        const s = sorted.get(key) ?? new Map();
        s.set(member, score);
        sorted.set(key, s);
        return 1;
      },
      zrangebyscore: async (key, min, max, ...args) => {
        const s = sorted.get(key);
        if (!s) return [];
        let offset = 0;
        let count = s.size;
        for (let i = 0; i < args.length; i++) {
          if (String(args[i]).toUpperCase() === 'LIMIT') {
            offset = Number(args[i + 1]);
            count = Number(args[i + 2]);
            break;
          }
        }
        return [...s.entries()]
          .filter(([, sc]) => sc >= min && sc <= max)
          .sort((a, b) => a[1] - b[1])
          .slice(offset, offset + count)
          .map(([m]) => m);
      },
      zremrangebyscore: async (key, min, max) => {
        const s = sorted.get(key);
        if (!s) return 0;
        let removed = 0;
        for (const [member, score] of s) {
          if (score >= min && score <= max) {
            s.delete(member);
            removed++;
          }
        }
        return removed;
      },
      _store: store,
    };
  }

  function makeAppendEvent(guardId, timestamp, overrides = {}) {
    return {
      kind: 'route_decision_skip',
      guardId,
      threadId: 'thread_append',
      catId: 'cat_append',
      ownerUserId: 'user_1',
      timestamp,
      correlationConfidence: 'window',
      ...overrides,
    };
  }

  it('3rd dedup_active append does NOT trigger escalation (real hook)', async () => {
    const redis = createFullFakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const triggerEval = mock.fn(async () => triggerSuccess());
    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = T;
    await log.append(makeAppendEvent('a2a_route_decision_skip', now, { normalizedReason: 'dedup_active' }));
    await log.append(makeAppendEvent('a2a_route_decision_skip', now + 120_000, { normalizedReason: 'dedup_active' }));
    await log.append(makeAppendEvent('a2a_route_decision_skip', now + 240_000, { normalizedReason: 'dedup_active' }));
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(triggerEval.mock.callCount(), 0, 'dedup_active must NOT trigger escalation via real append');
  });

  it('3rd eligible (depth) append DOES trigger escalation (real hook)', async () => {
    const redis = createFullFakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const triggerEval = mock.fn(async () => triggerSuccess());
    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = T;
    await log.append(makeAppendEvent('a2a_route_decision_skip', now, { normalizedReason: 'depth' }));
    await log.append(makeAppendEvent('a2a_route_decision_skip', now + 120_000, { normalizedReason: 'depth' }));
    await log.append(makeAppendEvent('a2a_route_decision_skip', now + 240_000, { normalizedReason: 'depth' }));
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(triggerEval.mock.callCount(), 1, 'depth must trigger escalation via real append at 3rd episode');
  });
});

// ---------------------------------------------------------------------------
// 8. Sol R3 P1-1: claim lifecycle — uncertain vs confirmed separation
// ---------------------------------------------------------------------------

describe('sol R3 P1-1: claim lifecycle — uncertain vs confirmed', () => {
  it('uncertainty-probe claim does NOT block confirmed claim (different key namespace)', async () => {
    // Phase 2 test: 3 real depth events → confirmed escalation must succeed
    // even when an uncertain claim from a prior dedup-cap already exists.
    const depthEvents = [
      rawEvent({
        timestamp: T,
        seq: 0,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      rawEvent({
        timestamp: T + 240_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(depthEvents);
    const triggerEval = mock.fn(async () => triggerSuccess());

    // Pre-set uncertain claim (simulates prior truncation-only escalation)
    // Sol R4 P2-1: TTL must match production UNCERTAINTY_PROBE_TTL_SECONDS (3600, not 300)
    await redis.set(
      'guard-rejection:uncertainty:user_1:a2a_route_decision_skip',
      JSON.stringify({ escalatedAt: T - 60_000, escalationKind: 'uncertainty_probe' }),
      'EX',
      3600,
      'NX',
    );

    const result = await checkGuardThreshold(depthEvents[2], {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.thresholdMet, true, 'confirmed threshold met');
    assert.equal(result.escalationKind, 'confirmed', 'episodeCount >= threshold → confirmed');
    assert.equal(result.escalated, true, 'confirmed escalation fires despite probe claim');
    assert.equal(result.alreadyEscalated, false, 'NOT blocked — different key namespace');
    assert.equal(triggerEval.mock.callCount(), 1, 'trigger fires for confirmed');
    // Sol R5 P2: seam-level — verify escalationKind reaches triggerEval (confirmed despite prior probe)
    const triggerArgs = triggerEval.mock.calls[0].arguments[0];
    assert.equal(triggerArgs.escalationKind, 'confirmed', 'triggerEval receives confirmed (not probe)');
  });

  it('confirmed claim blocks subsequent uncertainty-probe triggers', async () => {
    // When a confirmed 7d claim exists, truncation-only events should NOT
    // trigger another eval (real harm was already escalated).
    const capEvents = Array.from({ length: 10_001 }, (_, i) =>
      rawEvent({
        timestamp: T + i,
        seq: i,
        eventId: `confirm-block-${i}`,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(capEvents);
    const triggerEval = mock.fn(async () => triggerSuccess());

    // Pre-set confirmed claim (simulates prior real harm escalation)
    await redis.set(
      'guard-rejection:escalated:user_1:a2a_route_decision_skip',
      JSON.stringify({ escalatedAt: T - 60_000, escalationKind: 'confirmed' }),
      'EX',
      604800,
      'NX',
    );

    const result = await checkGuardThreshold(capEvents[capEvents.length - 1], {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.truncated, true, 'hard cap hit');
    assert.equal(result.escalationKind, 'uncertainty_probe', 'truncation-only → uncertainty_probe kind');
    assert.equal(result.alreadyEscalated, true, 'blocked by existing confirmed claim');
    assert.equal(result.escalated, false, 'no trigger fired');
    assert.equal(triggerEval.mock.callCount(), 0, 'triggerEval NOT called');
  });

  it('consecutive uncertainty-probe escalations are deduplicated within 1h (anti-storm)', async () => {
    // First truncation-only event → uncertain claim → fires trigger.
    // Second event with same guard → uncertain NX blocks → no second trigger.
    const capEvents = Array.from({ length: 10_001 }, (_, i) =>
      rawEvent({
        timestamp: T + i,
        seq: i,
        eventId: `storm-${i}`,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(capEvents);
    // Spy on redis.set to verify claim parameters
    const originalSet = redis.set.bind(redis);
    const setCalls = [];
    redis.set = async (...args) => {
      setCalls.push(args);
      return originalSet(...args);
    };
    const triggerEval = mock.fn(async () => triggerSuccess());

    // First call → uncertainty probe fires
    const r1 = await checkGuardThreshold(capEvents[capEvents.length - 1], {
      redis,
      guardRejectionLog,
      triggerEval,
    });
    assert.equal(r1.escalated, true, 'first uncertainty-probe fires');
    assert.equal(r1.escalationKind, 'uncertainty_probe');
    assert.equal(triggerEval.mock.callCount(), 1, '1 trigger after first call');
    // Sol R5 P2: seam-level — verify escalationKind reaches triggerEval (probe path)
    const probeArgs = triggerEval.mock.calls[0].arguments[0];
    assert.equal(probeArgs.escalationKind, 'uncertainty_probe', 'triggerEval receives uncertainty_probe');

    // Sol R4 P2-1: verify SET parameters — uncertainty key + EX 3600 + NX
    const claimSet = setCalls.find((c) => String(c[0]).includes('uncertainty:'));
    assert.ok(claimSet, 'SET call must use uncertainty: key prefix');
    assert.ok(
      String(claimSet[0]).startsWith('guard-rejection:uncertainty:'),
      'key prefix = guard-rejection:uncertainty:',
    );
    assert.equal(claimSet[2], 'EX', 'SET uses EX flag');
    assert.equal(claimSet[3], 3600, 'TTL = 3600 seconds (1h per Fable ruling)');
    assert.equal(claimSet[4], 'NX', 'SET uses NX flag');

    // Sol R4 P2-1: verify NO escalated: key exists (only uncertainty: key)
    const confirmedKey = 'guard-rejection:escalated:user_1:a2a_route_decision_skip';
    const confirmedExists = await redis.get(confirmedKey);
    assert.equal(confirmedExists, null, 'dedup-only cap must NOT create escalated: key (Fable invariant)');

    // Second call (same guard, same event source) → uncertain NX blocks
    const event2 = rawEvent({
      timestamp: T + 20_000,
      seq: 10002,
      eventId: 'storm-repeat',
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'dedup_active',
    });
    const r2 = await checkGuardThreshold(event2, {
      redis,
      guardRejectionLog,
      triggerEval,
    });
    assert.equal(r2.escalationKind, 'uncertainty_probe');
    assert.equal(r2.alreadyEscalated, true, 'second probe blocked by NX');
    assert.equal(r2.escalated, false, 'no second trigger');
    assert.equal(triggerEval.mock.callCount(), 1, 'still only 1 trigger total');
  });

  it('full two-phase scenario: dedup-cap uncertain → 3 depth confirmed', async () => {
    // Phase 1: 10k+ dedup_active → truncated → uncertain escalation
    const dedupCapEvents = Array.from({ length: 10_001 }, (_, i) =>
      rawEvent({
        timestamp: T + i,
        seq: i,
        eventId: `phase1-${i}`,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
    );
    const { redis: redis1, guardRejectionLog: log1 } = await createFakeEventSource(dedupCapEvents);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const phase1 = await checkGuardThreshold(dedupCapEvents[dedupCapEvents.length - 1], {
      redis: redis1,
      guardRejectionLog: log1,
      triggerEval,
    });
    assert.equal(phase1.escalationKind, 'uncertainty_probe', 'Phase 1: uncertainty_probe');
    assert.equal(phase1.escalated, true, 'Phase 1: probe fires');

    // Phase 2: 3 depth events with the SAME Redis store (claim keys persist)
    // but separate event source (simulates passage of time + new events)
    const depthEvents = [
      rawEvent({
        timestamp: T + 120_000,
        seq: 0,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      rawEvent({
        timestamp: T + 240_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      rawEvent({
        timestamp: T + 360_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
    ];
    // Create new event source with depth events but reuse Phase 1's Redis _store
    // for claim key persistence (the uncertain key from Phase 1 is in there).
    const { guardRejectionLog: log2 } = await createFakeEventSource(depthEvents);

    const phase2 = await checkGuardThreshold(depthEvents[2], {
      redis: redis1,
      guardRejectionLog: log2,
      triggerEval,
    });
    assert.equal(phase2.escalationKind, 'confirmed', 'Phase 2: confirmed');
    assert.equal(phase2.escalated, true, 'Phase 2: fires despite Phase 1 probe claim');
    assert.equal(phase2.alreadyEscalated, false, 'Phase 2: NOT blocked');
    assert.equal(triggerEval.mock.callCount(), 2, 'total 2 triggers: 1 probe + 1 confirmed');
  });
});
