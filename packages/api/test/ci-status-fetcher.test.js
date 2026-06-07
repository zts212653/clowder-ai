// @ts-check
// Pure helper coverage for CI status interpretation. These utils used to live in the
// (now-deleted) CiCdCheckPoller; they're the single source of truth in ci-status-fetcher,
// consumed by CiCdCheckTaskSpec. The poller's stale "CI pass → trigger" contract tests were
// dropped with it — the live CI-pass/-fail wake contract is covered by cicd-check-spec.test.js.

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeAggregateBucket,
  normalizeBucket,
  normalizePrState,
} from '../dist/infrastructure/email/ci-status-fetcher.js';

describe('normalizePrState', () => {
  it('returns merged when mergedAt is set', () => {
    assert.strictEqual(normalizePrState('MERGED', '2026-01-01'), 'merged');
  });

  it('returns merged when state is MERGED', () => {
    assert.strictEqual(normalizePrState('MERGED', null), 'merged');
  });

  it('returns closed when state is CLOSED', () => {
    assert.strictEqual(normalizePrState('CLOSED', null), 'closed');
  });

  it('returns open for OPEN state', () => {
    assert.strictEqual(normalizePrState('OPEN', null), 'open');
  });

  it('returns open for unknown state', () => {
    assert.strictEqual(normalizePrState('UNKNOWN', null), 'open');
  });
});

describe('normalizeBucket', () => {
  it('normalizes pass/success to pass', () => {
    assert.strictEqual(normalizeBucket('pass'), 'pass');
    assert.strictEqual(normalizeBucket('success'), 'pass');
    assert.strictEqual(normalizeBucket('SUCCESS'), 'pass');
  });

  it('normalizes fail/failure/error to fail', () => {
    assert.strictEqual(normalizeBucket('fail'), 'fail');
    assert.strictEqual(normalizeBucket('failure'), 'fail');
    assert.strictEqual(normalizeBucket('error'), 'fail');
    assert.strictEqual(normalizeBucket('FAILURE'), 'fail');
  });

  it('normalizes everything else to pending', () => {
    assert.strictEqual(normalizeBucket('pending'), 'pending');
    assert.strictEqual(normalizeBucket('in_progress'), 'pending');
    assert.strictEqual(normalizeBucket('queued'), 'pending');
  });
});

describe('computeAggregateBucket', () => {
  it('returns pending for empty rollup', () => {
    assert.strictEqual(computeAggregateBucket([]), 'pending');
  });

  it('returns pass when all checks succeed', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'success', __typename: 'CheckRun' },
      { status: 'COMPLETED', conclusion: 'skipped', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'pass');
  });

  it('returns fail when any check fails', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'success', __typename: 'CheckRun' },
      { status: 'COMPLETED', conclusion: 'failure', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });

  it('returns pending when checks are still in progress', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'success', __typename: 'CheckRun' },
      { status: 'IN_PROGRESS', conclusion: '', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'pending');
  });

  it('handles StatusContext (commit statuses)', () => {
    const rollup = [{ status: 'failure', conclusion: '', __typename: 'StatusContext' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });

  it('StatusContext success returns pass', () => {
    const rollup = [{ status: 'success', conclusion: '', __typename: 'StatusContext' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'pass');
  });

  it('StatusContext pending returns pending', () => {
    const rollup = [{ status: 'pending', conclusion: '', __typename: 'StatusContext' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'pending');
  });

  it('timed_out conclusion counts as failure', () => {
    const rollup = [{ status: 'COMPLETED', conclusion: 'timed_out', __typename: 'CheckRun' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });

  it('cancelled conclusion alone is NOT a failure but also NOT a green light → pending', () => {
    // A cancelled run is a superseded non-result: not a failure (no false CI-fail), but also not a
    // success (GitHub success states = success/skipped/neutral, not cancelled). With no real positive
    // result, the PR is not green → pending (never falsely wakes a merge-gate). [砚砚 review P1]
    const rollup = [{ status: 'COMPLETED', conclusion: 'cancelled', __typename: 'CheckRun' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'pending');
  });

  it('cancelled alongside a passing re-run aggregates to pass (not fail)', () => {
    // Common case: a run was superseded (cancelled) and the re-run passed.
    const rollup = [
      { status: 'COMPLETED', conclusion: 'cancelled', __typename: 'CheckRun' },
      { status: 'COMPLETED', conclusion: 'success', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'pass');
  });

  it('a real failure still wins over a cancelled run', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'cancelled', __typename: 'CheckRun' },
      { status: 'COMPLETED', conclusion: 'failure', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });

  it('failure takes priority over pending', () => {
    const rollup = [
      { status: 'IN_PROGRESS', conclusion: '', __typename: 'CheckRun' },
      { status: 'COMPLETED', conclusion: 'failure', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });
});
