import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { INVALID_PARAMS_CODE } from '@clowder-ai/plugin-contract';
import { executeBehaviorCase, M0C_BEHAVIOR_CASE_IDS } from '@clowder-ai/plugin-contract/conformance';

import { classifyWireCase, ExternalStdioBehaviorAdapter } from './plugin-m0d-behavior-adapter.js';

const require = createRequire(import.meta.url);
const OPAQUE_TOKEN_KEYS = new Set(['ackToken', 'nextPageToken', 'snapshotAckToken']);
export const M0D_BEHAVIOR_FIXTURE_PATH = require.resolve(
  '@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants',
);

function sanitizeEvidence(value, key) {
  if (key !== undefined && OPAQUE_TOKEN_KEYS.has(key) && value !== null) return '<opaque>';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item));
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeEvidence(entryValue, entryKey)]),
  );
}

function expectedOf(behaviorCase) {
  return {
    status: behaviorCase.expect.status,
    ...(behaviorCase.expect.errorCode === undefined ? {} : { errorCode: behaviorCase.expect.errorCode }),
  };
}

function classifyVerdict(wireValid, report, outcome) {
  if (wireValid) return report.passed ? 'pass' : 'canonical-mismatch';
  const sideEffectFailures = report.failures.filter((failure) => !failure.startsWith('errorCode:'));
  return outcome.status === 'error' && outcome.error?.code === INVALID_PARAMS_CODE && sideEffectFailures.length === 0
    ? 'schema-incompatible-at-frozen-sha'
    : 'admission-safety-failure';
}

export async function loadM0dBehaviorFixture() {
  return JSON.parse(await readFile(M0D_BEHAVIOR_FIXTURE_PATH, 'utf8'));
}

export function isM0dAcceptancePassed(report) {
  if (report.catalog.catalogMatches !== true || report.catalog.count !== 18) return false;
  return Object.keys(report.counts).length === 1 && report.counts.pass === 18;
}

export async function runM0dJointAcceptance() {
  const fixture = await loadM0dBehaviorFixture();
  const publishedIds = fixture.cases.map((behaviorCase) => behaviorCase.id);
  const catalogMatches =
    publishedIds.length === M0C_BEHAVIOR_CASE_IDS.length &&
    publishedIds.every((id, index) => id === M0C_BEHAVIOR_CASE_IDS[index]);
  const cases = [];

  for (const behaviorCase of fixture.cases) {
    const classification = classifyWireCase(behaviorCase);
    if (classification.transport === 'host-admin') {
      cases.push({
        id: behaviorCase.id,
        operation: behaviorCase.when.operation,
        transport: 'host-admin',
        verdict: 'not-implemented-at-frozen-sha',
        expected: expectedOf(behaviorCase),
        failures: ['no frozen Host execution surface'],
      });
      continue;
    }

    const adapter = new ExternalStdioBehaviorAdapter(behaviorCase);
    try {
      const report = await executeBehaviorCase(behaviorCase, adapter);
      const outcome = adapter.outcome;
      cases.push({
        id: behaviorCase.id,
        operation: behaviorCase.when.operation,
        method: classification.method,
        transport: classification.wireValid ? 'child-stdio' : 'child-stdio-admission',
        verdict: classifyVerdict(classification.wireValid, report, outcome),
        expected: expectedOf(behaviorCase),
        observed: sanitizeEvidence(outcome),
        failures: report.failures,
        sideEffectsPassed: report.failures.every(
          (failure) => failure.startsWith('status:') || failure.startsWith('errorCode:'),
        ),
        childPidObserved: adapter.processes.children[0]?.pid > 0,
        packageDigest: adapter.packageDigest,
      });
    } finally {
      await adapter.close();
    }
  }

  const counts = Object.fromEntries(
    [...new Set(cases.map((row) => row.verdict))]
      .sort()
      .map((verdict) => [verdict, cases.filter((row) => row.verdict === verdict).length]),
  );
  return {
    catalog: {
      source: '@clowder-ai/plugin-contract/fixtures/behavior/messaging/adversarial-invariants',
      count: cases.length,
      catalogMatches,
    },
    counts,
    cases,
  };
}
