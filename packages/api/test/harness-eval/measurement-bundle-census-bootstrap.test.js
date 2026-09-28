import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse, stringify } from 'yaml';
import {
  assertMeasurementVerdictActionAllowed,
  validateMeasurementBundleCensus,
} from '../../dist/infrastructure/harness-eval/measurement/measurement-bundle-census.js';
import {
  ensureMeasurementBundleCensusFile,
  refreshMeasurementBundleCensusFile,
} from '../../dist/infrastructure/harness-eval/measurement/measurement-bundle-census-file.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const censusRef = 'docs/harness-feedback/registry/measurement-bundles.yaml';
const domainDirRef = 'docs/harness-feedback/eval-domains';

function seedPublicRepo(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'public-census-bootstrap-'));
  const domainDir = resolve(root, domainDirRef);
  mkdirSync(domainDir, { recursive: true });
  for (const entry of readdirSync(resolve(repoRoot, domainDirRef), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (options.withoutDomainFile === entry.name) continue;
    cpSync(resolve(repoRoot, domainDirRef, entry.name), resolve(domainDir, entry.name));
  }
  mkdirSync(resolve(root, 'docs/harness-feedback/verdicts'), { recursive: true });
  return root;
}

function loadCensus(root) {
  return parse(readFileSync(resolve(root, censusRef), 'utf8'));
}

describe('public measurement census bootstrap', () => {
  it('creates a valid instance-local census without home certification metadata', () => {
    const root = seedPublicRepo();
    try {
      const result = ensureMeasurementBundleCensusFile(root, '2026-08-24T00:00:00.000Z');
      const census = loadCensus(root);
      const active = census.entries.filter((entry) => entry.classification === 'active_decision_bearing');

      assert.equal(result.created, true);
      assert.equal(result.path, resolve(root, censusRef));
      assert.ok(active.length > 0);
      assert.equal(
        active.every((entry) => entry.validityMigration.status === 'unmigrated'),
        true,
      );
      assert.equal(
        active.every((entry) => entry.validityMigration.actionGate === 'keep_observe_only'),
        true,
      );
      assert.equal(
        active.every((entry) =>
          [
            entry.validityMigration.certificateRef,
            entry.validityMigration.resultRef,
            entry.validityMigration.replayRef,
          ].every((ref) => ref === null),
        ),
        true,
      );
      assert.doesNotMatch(readFileSync(result.path, 'utf8'), /f267-[a-z0-9-]+\.(?:yaml|md)/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can start public migration with eval:memory as batch and risk rank 1', () => {
    const root = seedPublicRepo();
    try {
      ensureMeasurementBundleCensusFile(root, '2026-08-24T00:00:00.000Z');
      const census = loadCensus(root);
      const memory = census.entries.find((entry) => entry.domainId === 'eval:memory');

      assert.equal(memory.validityMigration.riskRank, 1);
      memory.validityMigration.batch = 1;
      memory.validityMigration.status = 'contract_ready';
      assert.doesNotThrow(() => validateMeasurementBundleCensus(census, root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unlocked active domain until it has an assigned migration batch', () => {
    const root = seedPublicRepo();
    try {
      ensureMeasurementBundleCensusFile(root, '2026-08-24T00:00:00.000Z');
      const census = loadCensus(root);
      const a2a = census.entries.find((entry) => entry.domainId === 'eval:a2a');
      a2a.validityMigration = {
        ...a2a.validityMigration,
        status: 'certified_usable',
        certificateRef: 'docs/harness-feedback/certificates/public-a2a.yaml',
        resultRef: 'docs/harness-feedback/results/public-a2a.json',
        replayRef: 'docs/harness-feedback/replays/public-a2a.json',
        actionGate: 'certificate_actions_allowed',
        hardBlockReason: null,
      };

      assert.equal(a2a.validityMigration.batch, null);
      assert.throws(() => validateMeasurementBundleCensus(census, root), /action gate.*batch/i);
      assert.throws(() => assertMeasurementVerdictActionAllowed(census, 'eval:a2a', 'fix'), /action gate.*batch/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves target-owned entries and adds a newly exported domain fail-closed', () => {
    const designGateFile = 'eval-design-gate.yaml';
    const root = seedPublicRepo({ withoutDomainFile: designGateFile });
    try {
      ensureMeasurementBundleCensusFile(root, '2026-08-24T00:00:00.000Z');
      const before = loadCensus(root);
      const a2a = before.entries.find((entry) => entry.domainId === 'eval:a2a');
      a2a.functionalEquivalents = ['target-owned public calibration note'];
      writeFileSync(resolve(root, censusRef), stringify(before));
      cpSync(resolve(repoRoot, domainDirRef, designGateFile), resolve(root, domainDirRef, designGateFile));

      const result = ensureMeasurementBundleCensusFile(root, '2026-08-25T00:00:00.000Z');
      const after = loadCensus(root);
      const added = after.entries.find((entry) => entry.domainId === 'eval:design-gate');
      const activeRanks = after.entries
        .filter((entry) => entry.classification === 'active_decision_bearing')
        .map((entry) => entry.validityMigration.riskRank);

      assert.equal(result.reconciled, true);
      assert.deepEqual(after.entries.find((entry) => entry.domainId === 'eval:a2a').functionalEquivalents, [
        'target-owned public calibration note',
      ]);
      assert.equal(added.validityMigration.status, 'unmigrated');
      assert.equal(added.validityMigration.actionGate, 'keep_observe_only');
      assert.equal(added.validityMigration.riskRank, Math.max(...activeRanks));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles an existing domain owner without replacing instance-owned calibration', () => {
    const root = seedPublicRepo();
    const registryPath = resolve(root, domainDirRef, 'eval-freshness.yaml');
    try {
      const domain = parse(readFileSync(registryPath, 'utf8'));
      domain.handoffTargetResolver.ownerCatId = 'codex';
      writeFileSync(registryPath, stringify(domain));
      ensureMeasurementBundleCensusFile(root, '2026-09-05T00:00:00.000Z');
      const before = loadCensus(root);
      const memory = before.entries.find((entry) => entry.domainId === 'eval:memory');
      memory.functionalEquivalents = ['instance-owned memory calibration'];
      memory.validityMigration = {
        ...memory.validityMigration,
        batch: 1,
        status: 'certified_usable',
        certificateRef: 'public-memory-certificate.yaml',
        resultRef: 'public-memory-result.json',
        replayRef: 'public-memory-replay.json',
        actionGate: 'certificate_actions_allowed',
        hardBlockReason: null,
      };
      writeFileSync(resolve(root, censusRef), stringify(before));
      domain.handoffTargetResolver.ownerCatId = 'codex-sol';
      writeFileSync(registryPath, stringify(domain));

      const result = ensureMeasurementBundleCensusFile(root, '2026-09-10T00:00:00.000Z');
      const after = loadCensus(root);

      assert.equal(result.reconciled, true);
      assert.deepEqual(
        after.entries.map((entry) => entry.domainId),
        before.entries.map((entry) => entry.domainId),
      );
      assert.equal(
        after.entries.find((entry) => entry.domainId === 'eval:freshness').decisionConsumer.ownerCatId,
        'codex-sol',
      );
      for (const previous of before.entries) {
        const current = after.entries.find((entry) => entry.domainId === previous.domainId);
        assert.deepEqual(current.validityMigration, previous.validityMigration);
        assert.deepEqual(current.functionalEquivalents, previous.functionalEquivalents);
      }
      assert.doesNotThrow(() => validateMeasurementBundleCensus(after, root));
      assert.doesNotThrow(() => assertMeasurementVerdictActionAllowed(after, 'eval:memory', 'fix'));
      assert.throws(() => assertMeasurementVerdictActionAllowed(after, 'eval:freshness', 'fix'), /keep_observe_only/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an unchanged registry census byte-for-byte intact', () => {
    const root = seedPublicRepo();
    try {
      const initial = ensureMeasurementBundleCensusFile(root, '2026-09-05T00:00:00.000Z');
      const source = `# Instance-owned commentary\n${initial.source}`;
      writeFileSync(initial.path, source);
      const inode = statSync(initial.path).ino;

      const result = ensureMeasurementBundleCensusFile(root, '2026-09-10T00:00:00.000Z');

      assert.equal(result.created, false);
      assert.equal(result.reconciled, false);
      assert.equal(result.source, source);
      assert.equal(readFileSync(initial.path, 'utf8'), source);
      assert.equal(statSync(initial.path).ino, inode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires explicit migration for domain removal without changing the census', () => {
    const root = seedPublicRepo();
    try {
      const initial = ensureMeasurementBundleCensusFile(root, '2026-09-05T00:00:00.000Z');
      rmSync(resolve(root, domainDirRef, 'eval-freshness.yaml'));

      assert.throws(
        () => ensureMeasurementBundleCensusFile(root, '2026-09-10T00:00:00.000Z'),
        /domain removal requires explicit migration/,
      );
      assert.equal(readFileSync(initial.path, 'utf8'), initial.source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not impose bootstrap activation on an already valid instance census', () => {
    const root = seedPublicRepo();
    try {
      const initial = ensureMeasurementBundleCensusFile(root, '2026-09-05T00:00:00.000Z');
      const domainPath = resolve(root, domainDirRef, 'eval-memory.yaml');
      const domain = parse(readFileSync(domainPath, 'utf8'));
      domain.enabled = false;
      writeFileSync(domainPath, stringify(domain));
      const census = loadCensus(root);
      const memory = census.entries.find((entry) => entry.domainId === 'eval:memory');
      memory.enabled = false;
      memory.classification = 'gated';
      memory.decisionConsumer.allowedActions = [];
      memory.validityMigration = { ...memory.validityMigration, riskRank: null, status: 'gated' };
      for (const entry of census.entries) {
        if (entry.validityMigration.riskRank !== null) entry.validityMigration.riskRank -= 1;
      }
      assert.doesNotThrow(() => validateMeasurementBundleCensus(census, root));
      const source = stringify(census);
      writeFileSync(initial.path, source);

      const result = ensureMeasurementBundleCensusFile(root, '2026-09-10T00:00:00.000Z');

      assert.equal(result.reconciled, false);
      assert.equal(readFileSync(initial.path, 'utf8'), source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not repair invalid instance authorization into a publishable census', () => {
    const root = seedPublicRepo();
    try {
      const initial = ensureMeasurementBundleCensusFile(root, '2026-09-05T00:00:00.000Z');
      const census = loadCensus(root);
      const memory = census.entries.find((entry) => entry.domainId === 'eval:memory');
      memory.validityMigration.actionGate = 'certificate_actions_allowed';
      const source = stringify(census);
      writeFileSync(initial.path, source);

      assert.throws(() => ensureMeasurementBundleCensusFile(root, '2026-09-10T00:00:00.000Z'), /action gate.*batch/i);
      assert.equal(readFileSync(initial.path, 'utf8'), source);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically replaces the census when publisher-derived fields refresh', () => {
    const root = seedPublicRepo();
    try {
      const initial = ensureMeasurementBundleCensusFile(root, '2026-08-24T00:00:00.000Z');
      const beforeInode = statSync(initial.path).ino;
      writeFileSync(resolve(root, 'docs/harness-feedback/verdicts/public-first.md'), '---\ndomain_id: eval:a2a\n---\n');
      refreshMeasurementBundleCensusFile(root, '2026-08-24T01:00:00.000Z', initial.source);

      assert.notEqual(statSync(initial.path).ino, beforeInode, 'refresh must replace via same-directory rename');
      assert.equal(loadCensus(root).committedVerdictArtifactCount, 1);
      assert.deepEqual(
        readdirSync(dirname(initial.path)).filter((name) => name.startsWith(`${basename(initial.path)}.`)),
        [],
        'atomic refresh must not leak temporary siblings',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes the first clean-clone verdict and stages the bootstrapped census', async () => {
    const liveRoot = setupHarnessFeedback();
    const isolatedRoot = seedPublicRepo();
    let stageResult;
    try {
      const result = await handlePublishVerdict(
        {
          harnessFeedbackRoot: liveRoot,
          gitPublisher: {
            async publishOnIsolatedWorktree(options) {
              stageResult = await options.stage(isolatedRoot);
              return { commitSha: 'first-public-verdict-sha', prUrl: 'https://example.test/pr/1' };
            },
          },
          generator: async (packet, _sourceRefs, deps) => {
            const bundleDir = resolve(deps.harnessFeedbackRoot, 'bundles', packet.id);
            const verdictPath = resolve(deps.harnessFeedbackRoot, 'verdicts', `${packet.id}.md`);
            mkdirSync(bundleDir, { recursive: true });
            writeFileSync(verdictPath, `---\ndomain_id: ${packet.domainId}\n---\n`);
            return { bundleDir, verdictPath };
          },
        },
        {
          packet: buildPacket({ id: 'public-first-verdict', domainId: 'eval:a2a' }),
          domain: 'eval:a2a',
          catId: 'codex',
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        },
      );

      assert.ok(!('error' in result), JSON.stringify(result));
      assert.ok(stageResult.paths.includes(resolve(isolatedRoot, censusRef)));
      assert.equal(loadCensus(isolatedRoot).committedVerdictArtifactCount, 1);
    } finally {
      rmSync(liveRoot, { recursive: true, force: true });
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});
