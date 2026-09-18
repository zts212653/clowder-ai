/**
 * F192 Phase H publish-verdict shared test fixtures.
 * Extracted from publish-verdict.test.js per AGENTS.md 350-line hard limit.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Copy the canonical measurement-policy inputs into an isolated test repository. */
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

/** Opt an isolated test domain into actionable verdicts with complete evidence refs. */
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

/** F257 / F192 sunset: storage-neutral publisher mock for handler tests. */
export function createMockArtifactPublisher(opts = {}) {
  return {
    async publishArtifact({ packet, generate }) {
      if (opts.failWith) throw new Error(opts.failWith);
      if (opts.duplicateIds?.has(packet.id)) throw new Error(`artifact_already_exists:${packet.id}`);

      const tmpRoot = mkdtempSync(join(tmpdir(), `mock-artifact-${packet.id}-`));
      try {
        const generated = await generate(tmpRoot);
        const verdictPath = generated.verdictPath.startsWith(tmpRoot)
          ? generated.verdictPath
          : resolve(tmpRoot, basename(generated.verdictPath));
        const bundleDir = generated.bundleDir.startsWith(tmpRoot)
          ? generated.bundleDir
          : resolve(tmpRoot, basename(generated.bundleDir));
        mkdirSync(dirname(verdictPath), { recursive: true });
        mkdirSync(bundleDir, { recursive: true });
        if (!existsSync(verdictPath)) writeFileSync(verdictPath, `# Mock verdict for ${packet.id}\n`);

        if (opts.beforePublish) {
          await opts.beforePublish({ packet, generated, tmpRoot, verdictPath, bundleDir });
        }
        if (opts.failAfterGenerate) throw new Error(opts.failAfterGenerate);
        if (generated.afterPublish) await generated.afterPublish();
        if (opts.afterPublish) {
          await opts.afterPublish({ packet, generated, tmpRoot, verdictPath, bundleDir });
        }
        return {
          artifactId: opts.artifactId ?? packet.id,
          domainSlug: opts.domainSlug ?? packet.domainId.replace(/:/g, '-'),
          verdictPath,
          bundleDir,
          artifactUrl: opts.artifactUrl ?? `artifact://${packet.domainId}/${packet.id}`,
        };
      } catch (err) {
        rmSync(tmpRoot, { recursive: true, force: true });
        throw err;
      }
    },
  };
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
