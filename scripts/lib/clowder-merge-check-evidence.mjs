const PASSING_CHECK_RESULTS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const PENDING_CHECK_RESULTS = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING']);

export const EMPTY_CHECK_ROLLUP_STABILITY_MS = 60_000;

function hasStableEmptyRollupEvidence(statusCheckRollup, statusCheckObservation, expectedHead) {
  if (!Array.isArray(statusCheckRollup)) return false;
  if (statusCheckRollup.length !== 0) return false;
  if (statusCheckObservation?.kind !== 'stable_empty_rollup') return false;

  const first = statusCheckObservation.first;
  const second = statusCheckObservation.second;
  if (first?.headRefOid !== expectedHead) return false;
  if (second?.headRefOid !== expectedHead) return false;
  if (!Number.isSafeInteger(first.observedAtMs)) return false;
  if (!Number.isSafeInteger(second.observedAtMs)) return false;
  return second.observedAtMs - first.observedAtMs >= EMPTY_CHECK_ROLLUP_STABILITY_MS;
}

function normalizeCheckField(check, field) {
  const value = check?.[field];
  return typeof value === 'string' ? value.toUpperCase() : '';
}

function firstCheckResult(conclusion, state, status) {
  if (conclusion) return conclusion;
  if (state) return state;
  return status;
}

function classifyOneStatusCheck(check) {
  const conclusion = normalizeCheckField(check, 'conclusion');
  const state = normalizeCheckField(check, 'state');
  const status = normalizeCheckField(check, 'status');
  const isCheckRun = check?.__typename === 'CheckRun' ? true : conclusion.length > 0;
  if (isCheckRun && status !== 'COMPLETED') return 'pending';

  const result = firstCheckResult(conclusion, state, status);
  if (PASSING_CHECK_RESULTS.has(result)) return 'passed';
  if (PENDING_CHECK_RESULTS.has(result)) return 'pending';
  if (status && status !== 'COMPLETED') return 'pending';
  return 'failed';
}

export function classifyStatusChecks(statusCheckRollup, statusCheckObservation, expectedHead) {
  if (!Array.isArray(statusCheckRollup)) return 'unavailable';
  if (statusCheckRollup.length === 0) {
    return hasStableEmptyRollupEvidence(statusCheckRollup, statusCheckObservation, expectedHead)
      ? 'passed'
      : 'unavailable';
  }

  let sawPending = false;
  for (const check of statusCheckRollup) {
    const classification = classifyOneStatusCheck(check);
    if (classification === 'pending') {
      sawPending = true;
      continue;
    }
    if (classification === 'failed') return 'failed';
  }
  return sawPending ? 'pending' : 'passed';
}

function waitFor(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Disambiguate an empty GitHub rollup without weakening first-observation safety.
 * A no-check repository is admitted only after two empty observations of the
 * same HEAD separated by one full CI poll interval. The second truth is always
 * returned so a new HEAD or newly-created check is evaluated normally.
 */
export async function observeMergePrTruth(prNumber, { readPrTruth, wait = waitFor, now = Date.now } = {}) {
  if (typeof readPrTruth !== 'function') throw new TypeError('readPrTruth is required');

  const firstTruth = readPrTruth(prNumber);
  if (!Array.isArray(firstTruth?.statusCheckRollup)) {
    return { prTruth: firstTruth, statusCheckObservation: null };
  }
  if (firstTruth.statusCheckRollup.length !== 0) {
    return { prTruth: firstTruth, statusCheckObservation: null };
  }

  const firstObservedAtMs = now();
  await wait(EMPTY_CHECK_ROLLUP_STABILITY_MS);
  const secondTruth = readPrTruth(prNumber);
  const secondObservedAtMs = now();
  const sameHead = firstTruth.headRefOid === secondTruth?.headRefOid;
  const secondRollupIsEmpty =
    Array.isArray(secondTruth?.statusCheckRollup) && secondTruth.statusCheckRollup.length === 0;

  return {
    prTruth: secondTruth,
    statusCheckObservation:
      sameHead && secondRollupIsEmpty
        ? {
            kind: 'stable_empty_rollup',
            first: { headRefOid: firstTruth.headRefOid, observedAtMs: firstObservedAtMs },
            second: { headRefOid: secondTruth.headRefOid, observedAtMs: secondObservedAtMs },
          }
        : null,
  };
}
