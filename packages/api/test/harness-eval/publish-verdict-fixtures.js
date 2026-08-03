/**
 * F192 Phase H publish-verdict shared test fixtures.
 * Extracted from publish-verdict.test.js per AGENTS.md 350-line hard limit.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/**
 * Seed the committed state that a real GitWorktreePublisher checks out from
 * origin/main. Verdict generators may add domain-specific fixtures afterwards,
 * but the F267 census refresh must always start from a complete repository.
 */
export function seedCanonicalMeasurementCensusState(isolatedRepoRoot) {
  rmSync(resolve(isolatedRepoRoot, 'docs/harness-feedback/bundles'), { recursive: true, force: true });
  for (const relativePath of [
    'docs/harness-feedback/eval-domains',
    'docs/harness-feedback/verdicts',
    'docs/harness-feedback/registry/measurement-bundles.yaml',
  ]) {
    const target = resolve(isolatedRepoRoot, relativePath);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(resolve(target, '..'), { recursive: true });
    cpSync(resolve(REPO_ROOT, relativePath), target, { recursive: true });
  }
}

/**
 * Upgrade one seeded census entry to the state required by an actionable
 * publisher-path test. The default fixture intentionally remains fail-closed;
 * callers must opt into this state so old generator tests cannot accidentally
 * prove that an uncertified bundle may publish owner actions.
 */
export function markMeasurementCensusDomainCertifiedUsable(isolatedRepoRoot, domainId) {
  const censusPath = resolve(isolatedRepoRoot, 'docs/harness-feedback/registry/measurement-bundles.yaml');
  const census = parseYaml(readFileSync(censusPath, 'utf8'));
  const entry = census.entries.find((candidate) => candidate.domainId === domainId);
  if (!entry) throw new Error(`missing measurement census entry for ${domainId}`);
  entry.validityMigration = {
    ...entry.validityMigration,
    status: 'certified_usable',
    certificateRef: `docs/harness-feedback/certificates/test-${domainId}.yaml`,
    resultRef: `docs/harness-feedback/measurement-results/test-${domainId}.yaml`,
    replayRef: `docs/harness-feedback/replays/test-${domainId}.yaml`,
    actionGate: 'certificate_actions_allowed',
    hardBlockReason: null,
  };
  writeFileSync(censusPath, stringifyYaml(census));
}

/**
 * Build a valid VerdictHandoffPacket with override-able fields.
 * Mirrors verdictHandoffPacketSchema shape; tests override specific fields
 * to exercise validation edges.
 */
export function buildPacket(overrides = {}) {
  return {
    id: 'vhp-test-001',
    domainId: 'eval:a2a',
    createdAt: '2026-06-05T11:00:00.000Z',
    phenomenon: 'Test phenomenon for Phase H',
    harnessUnderEval: { featureId: 'F167', componentId: 'C1', name: 'test-component' },
    evidencePacket: {
      snapshotRefs: ['snapshot:bundle/test/snapshot'],
      attributionRefs: ['attribution:bundle/test/finding-001'],
      metricRefs: ['metric:c1.test'],
      sampleTraceRefs: ['trace:test-001'],
    },
    dailyTrend: {
      window: '24h',
      current: { 'c1.test': 5 },
      baseline: { 'c1.test': 2 },
      threshold: { 'c1.test': 10 },
      direction: 'regressed',
    },
    rootCauseHypothesis: {
      summary: 'Test hypothesis',
      confidence: 'medium',
      alternatives: ['alt-1'],
    },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F167', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-12T11:00:00.000Z', closureCondition: 'no friction' },
    counterarguments: ['counter-1'],
    ...overrides,
  };
}
