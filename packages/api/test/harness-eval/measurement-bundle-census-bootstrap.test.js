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
});
