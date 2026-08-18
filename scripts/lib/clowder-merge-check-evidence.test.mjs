import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planClowderMergeExecution } from '../clowder-merge-execution.mjs';
import { EMPTY_CHECK_ROLLUP_STABILITY_MS, observeMergePrTruth } from './clowder-merge-check-evidence.mjs';

const REPOSITORY = 'zts212653/clowder-ai';
const PR_NUMBER = 1185;
const OLD_HEAD = '1'.repeat(40);
const CURRENT_HEAD = '2'.repeat(40);

function emptyTruth(headRefOid = CURRENT_HEAD) {
  return {
    state: 'OPEN',
    headRefOid,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [],
  };
}

function planWithObservation(statusCheckObservation) {
  return planClowderMergeExecution({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    expectedHead: CURRENT_HEAD,
    prTruth: emptyTruth(),
    statusCheckObservation,
    authorization: {
      sourceMessageId: '0000000000000000-000000-deadbeef',
      subjectRef: `pr:${REPOSITORY}#${PR_NUMBER}`,
      scope: 'pull_request',
    },
  });
}

function planWithChecks(statusCheckRollup) {
  return planClowderMergeExecution({
    repository: REPOSITORY,
    prNumber: PR_NUMBER,
    expectedHead: CURRENT_HEAD,
    prTruth: { ...emptyTruth(), statusCheckRollup },
    authorization: {
      sourceMessageId: '0000000000000000-000000-deadbeef',
      subjectRef: `pr:${REPOSITORY}#${PR_NUMBER}`,
      scope: 'pull_request',
    },
  });
}

function stableObservation(overrides = {}) {
  return {
    kind: 'stable_empty_rollup',
    first: { headRefOid: CURRENT_HEAD, observedAtMs: 1_000 },
    second: { headRefOid: CURRENT_HEAD, observedAtMs: 61_000 },
    ...overrides,
  };
}

async function observeSequence(truths) {
  let now = 1_000;
  const waits = [];
  const reads = [...truths];
  const result = await observeMergePrTruth(PR_NUMBER, {
    readPrTruth: () => reads.shift(),
    wait: async (delayMs) => {
      waits.push(delayMs);
      now += delayMs;
    },
    now: () => now,
  });
  return { ...result, waits, remainingReads: reads.length };
}

describe('stable empty status-check evidence', () => {
  it('keeps every non-completed CheckRun pending even with a passing conclusion', () => {
    for (const status of ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', undefined]) {
      for (const conclusion of ['SUCCESS', 'SKIPPED', 'NEUTRAL']) {
        const result = planWithChecks([{ __typename: 'CheckRun', status, conclusion }]);
        assert.equal(result.reasonCode, 'checks_pending', `${status} + ${conclusion} must fail closed`);
      }
    }
  });

  it('still admits a successful StatusContext without CheckRun lifecycle fields', () => {
    const result = planWithChecks([{ __typename: 'StatusContext', status: 'SUCCESS', conclusion: '' }]);
    assert.equal(result.outcome, 'admitted');
  });

  it('admits an empty rollup only after one full same-HEAD stability window', () => {
    const admitted = planWithObservation(stableObservation());
    const tooShort = planWithObservation(
      stableObservation({
        second: { headRefOid: CURRENT_HEAD, observedAtMs: 60_999 },
      }),
    );
    const crossedHeads = planWithObservation(
      stableObservation({
        first: { headRefOid: OLD_HEAD, observedAtMs: 1_000 },
      }),
    );

    assert.equal(admitted.outcome, 'admitted');
    assert.equal(tooShort.reasonCode, 'checks_unavailable');
    assert.equal(crossedHeads.reasonCode, 'checks_unavailable');
  });

  it('builds evidence from two empty observations of the same HEAD one minute apart', async () => {
    const result = await observeSequence([emptyTruth(), emptyTruth()]);

    assert.deepEqual(result.waits, [EMPTY_CHECK_ROLLUP_STABILITY_MS]);
    assert.equal(result.remainingReads, 0);
    assert.deepEqual(result.statusCheckObservation, stableObservation());
  });

  it('fails closed when the HEAD changes during the stability window', async () => {
    const result = await observeSequence([emptyTruth(), emptyTruth(OLD_HEAD)]);

    assert.equal(result.prTruth.headRefOid, OLD_HEAD);
    assert.equal(result.statusCheckObservation, null);
  });

  it('uses a newly-created check normally instead of preserving empty evidence', async () => {
    const secondTruth = {
      ...emptyTruth(),
      statusCheckRollup: [{ name: 'CI', status: 'IN_PROGRESS', conclusion: null }],
    };
    const result = await observeSequence([emptyTruth(), secondTruth]);

    assert.deepEqual(result.prTruth.statusCheckRollup, secondTruth.statusCheckRollup);
    assert.equal(result.statusCheckObservation, null);
  });

  it('does not wait or reread when checks already exist', async () => {
    const checkTruth = {
      ...emptyTruth(),
      statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    };
    const result = await observeSequence([checkTruth, emptyTruth()]);

    assert.deepEqual(result.waits, []);
    assert.equal(result.remainingReads, 1);
    assert.equal(result.statusCheckObservation, null);
  });
});
