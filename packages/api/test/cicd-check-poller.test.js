// @ts-check

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeAggregateBucket,
  normalizeBucket,
  normalizePrState,
} from '../dist/infrastructure/email/CiCdCheckPoller.js';

// ─── Unit tests for pure helper functions ──────────────────────────

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

  it('cancelled conclusion counts as failure', () => {
    const rollup = [{ status: 'COMPLETED', conclusion: 'cancelled', __typename: 'CheckRun' }];
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
