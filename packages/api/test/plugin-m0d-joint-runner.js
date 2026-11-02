import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { executeBehaviorCase } from '@clowder-ai/plugin-contract/conformance';

import { ExternalStdioBehaviorAdapter } from './plugin-m0d-behavior-adapter.js';
import { loadM0dExecutionPlan, M0D_PROTOCOL_CASE_IDS } from './plugin-m0d-execution-plan.js';
import { HostControlBehaviorAdapter } from './plugin-m0d-host-control-adapter.js';
import { evaluateDeclaredVerdict } from './plugin-m0d-verdict-oracle.js';

const require = createRequire(import.meta.url);
const OPAQUE_TOKEN_KEYS = new Set(['ackToken', 'nextPageToken', 'snapshotAckToken']);
const TRANSPORT_BY_PLANE = Object.freeze({
  'plugin-to-host-wire': 'child-stdio',
  'wire-admission': 'child-stdio-admission',
  'host-to-plugin-delivery': 'host-to-plugin',
  'host-control': 'host-control',
});
const WIRE_PLANES = new Set(['plugin-to-host-wire', 'wire-admission']);
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

function createAdapter(behaviorCase, execution) {
  if (WIRE_PLANES.has(execution.plane)) {
    return new ExternalStdioBehaviorAdapter(behaviorCase, execution);
  }
  return new HostControlBehaviorAdapter(behaviorCase);
}

function observedEvidence(adapter, execution) {
  if (WIRE_PLANES.has(execution.plane)) {
    return sanitizeEvidence(adapter.outcome);
  }
  const rawHostErrorCode = adapter.rawHostErrorCode ?? null;
  if (execution.plane === 'host-to-plugin-delivery') {
    return {
      rawHostErrorCode,
      runtimeStartCount: adapter.processes.specs.length,
      deliveryFrameCount: adapter.processes.deliveryFrames.length,
      observations: adapter.observations,
    };
  }
  return { rawHostErrorCode, observations: adapter.observations };
}

export async function loadM0dBehaviorFixture() {
  const fixture = JSON.parse(await readFile(M0D_BEHAVIOR_FIXTURE_PATH, 'utf8'));
  fixture.cases = fixture.cases.filter((row) => M0D_PROTOCOL_CASE_IDS.includes(row.id));
  return fixture;
}

export function isM0dAcceptancePassed(report) {
  if (report.catalog.catalogMatches !== true || report.catalog.count !== M0D_PROTOCOL_CASE_IDS.length) return false;
  return Object.keys(report.counts).length === 1 && report.counts.pass === M0D_PROTOCOL_CASE_IDS.length;
}

export async function runM0dJointAcceptance() {
  const fixture = await loadM0dBehaviorFixture();
  const executionPlan = loadM0dExecutionPlan(fixture);
  const publishedIds = fixture.cases.map((behaviorCase) => behaviorCase.id);
  const catalogMatches =
    publishedIds.length === M0D_PROTOCOL_CASE_IDS.length &&
    publishedIds.every((id, index) => id === M0D_PROTOCOL_CASE_IDS[index]);
  const cases = [];

  for (const [index, behaviorCase] of fixture.cases.entries()) {
    const { execution } = executionPlan[index];
    const adapter = createAdapter(behaviorCase, execution);
    try {
      const report = await executeBehaviorCase(behaviorCase, adapter);
      const { verdict, sideEffectsPassed } = evaluateDeclaredVerdict(execution, report, adapter.outcome);
      cases.push({
        id: behaviorCase.id,
        operation: behaviorCase.when.operation,
        plane: execution.plane,
        ...(execution.method === undefined ? {} : { method: execution.method }),
        verdictOracle: execution.verdictOracle,
        transport: TRANSPORT_BY_PLANE[execution.plane],
        verdict,
        expected: expectedOf(behaviorCase),
        observed: observedEvidence(adapter, execution),
        failures: report.failures,
        sideEffectsPassed,
        childPidObserved: Number.isSafeInteger(adapter.processes?.children[0]?.pid),
        packageDigest: adapter.packageDigest ?? null,
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
