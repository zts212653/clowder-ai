// F267 dormancy contract (owner decision 2026-10-01, thread_mupggks0yeok6y3i):
// dormant = current scheduling lifecycle, not a loss of historical validity.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse, stringify } from 'yaml';
import { parseEvalDomainRegistryEntry } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';
import {
  assertMeasurementVerdictActionAllowed,
  validateMeasurementBundleCensus,
} from '../../dist/infrastructure/harness-eval/measurement/measurement-bundle-census.js';
import { ensureMeasurementBundleCensusFile } from '../../dist/infrastructure/harness-eval/measurement/measurement-bundle-census-file.js';

import { reviveActiveEraRegistry } from './measurement-census-active-era.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const censusRef = 'docs/harness-feedback/registry/measurement-bundles.yaml';
const domainDirRef = 'docs/harness-feedback/eval-domains';
const DORMANCY = {
  reason: 'No named consumer acts on this measure.',
  revivalPath: 'Bind it to a real F311 Program with a named consumer and a fresh F267 judgment.',
  decisionRef: 'thread_mupggks0yeok6y3i#0001790862754427-003141-74daa9e6',
};

function seedRepo(t, { withCensus = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'f267-dormancy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const copies = [domainDirRef, 'docs/harness-feedback/verdicts'];
  if (withCensus) copies.push(censusRef);
  for (const relativePath of copies) {
    const target = resolve(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(repoRoot, relativePath), target, { recursive: true });
  }
  return root;
}

// Synthetic certified history: never inherit a private installation's evidence.
function seedCertifiedHistory(t) {
  const root = seedRepo(t, { withCensus: false });
  reviveActiveEraRegistry(resolve(root, domainDirRef));
  const census = reconcile(root);
  const memory = entryOf(census, 'eval:memory').validityMigration;
  assert.equal(memory.riskRank, 1);
  Object.assign(memory, {
    batch: 1,
    status: 'certified_insufficient',
    certificateRef: 'fixture://memory/certificate',
    resultRef: 'fixture://memory/result',
    replayRef: 'fixture://memory/replay',
  });
  const a2a = entryOf(census, 'eval:a2a').validityMigration;
  assert.equal(a2a.riskRank, 2);
  Object.assign(a2a, { batch: 2, status: 'contract_ready' });
  validateMeasurementBundleCensus(census, root);
  writeFileSync(resolve(root, censusRef), stringify(census));
  // Return to the shipped lifecycle while retaining the synthetic coordinates.
  cpSync(resolve(repoRoot, domainDirRef), resolve(root, domainDirRef), { recursive: true });
  const dormant = reconcile(root);
  assert.deepEqual(
    dormant.entries.map((entry) => [entry.domainId, entry.validityMigration]),
    census.entries.map((entry) => [entry.domainId, entry.validityMigration]),
    'dormancy preserves every historical coordinate and evidence ref, not only the active subset',
  );
  return root;
}

function editDomain(root, file, mutate) {
  const path = resolve(root, domainDirRef, file);
  const value = parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, stringify(value));
}

const makeDormant = (value) => {
  value.dormancy = { ...DORMANCY };
  value.enabled = false;
};
const revive = (value) => {
  delete value.dormancy;
  value.enabled = true;
};

function reconcile(root) {
  ensureMeasurementBundleCensusFile(root, '2026-10-01T00:00:00.000Z');
  return parse(readFileSync(resolve(root, censusRef), 'utf8'));
}

function entryOf(census, domainId) {
  const entry = census.entries.find((candidate) => candidate.domainId === domainId);
  assert.ok(entry, `missing census entry ${domainId}`);
  return entry;
}

function registryFixture(overrides = {}) {
  const base = parse(readFileSync(resolve(repoRoot, domainDirRef, 'eval-qc.yaml'), 'utf8'));
  delete base.dormancy;
  return { ...base, enabled: true, ...overrides };
}

describe('F267 dormant measurement bundles', () => {
  it('rejects incomplete dormancy blocks and dormancy on an enabled domain', () => {
    assert.doesNotThrow(() => parseEvalDomainRegistryEntry(registryFixture({ enabled: false, dormancy: DORMANCY })));
    for (const field of ['reason', 'revivalPath', 'decisionRef']) {
      const incomplete = { ...DORMANCY };
      delete incomplete[field];
      assert.throws(
        () => parseEvalDomainRegistryEntry(registryFixture({ enabled: false, dormancy: incomplete })),
        new RegExp(field),
      );
    }
    assert.throws(
      () => parseEvalDomainRegistryEntry(registryFixture({ enabled: true, dormancy: DORMANCY })),
      /dormancy requires enabled: false/,
    );
    assert.throws(
      () => parseEvalDomainRegistryEntry(registryFixture({ dormancy: DORMANCY, enabled: undefined })),
      /dormancy requires enabled: false/,
    );
  });

  it('keeps certified memory history intact when it goes dormant and closes current actions', (t) => {
    const root = seedCertifiedHistory(t);
    editDomain(root, 'eval-memory.yaml', revive);
    const active = entryOf(reconcile(root), 'eval:memory');
    assert.equal(active.classification, 'active_decision_bearing');

    editDomain(root, 'eval-memory.yaml', makeDormant);
    const dormant = entryOf(reconcile(root), 'eval:memory');
    assert.equal(dormant.classification, 'dormant');
    assert.equal(dormant.enabled, false);
    assert.deepEqual(dormant.decisionConsumer.allowedActions, []);
    assert.deepEqual(dormant.validityMigration, active.validityMigration);
    assert.equal(dormant.validityMigration.batch, 1);
    assert.equal(dormant.validityMigration.certificateRef, 'fixture://memory/certificate');
    assert.equal(dormant.validityMigration.actionGate, 'keep_observe_only');
  });

  it('keeps a never-certified domain without refs, rank, or batch when it goes dormant', (t) => {
    const root = seedRepo(t);
    editDomain(root, 'eval-capability-tips.yaml', makeDormant);
    const tips = entryOf(reconcile(root), 'eval:capability-tips');
    assert.equal(tips.classification, 'dormant');
    assert.equal(tips.validityMigration.riskRank, null);
    assert.equal(tips.validityMigration.batch, null);
    assert.deepEqual(
      [tips.validityMigration.certificateRef, tips.validityMigration.resultRef, tips.validityMigration.replayRef],
      [null, null, null],
    );
  });

  it('still classifies a disabled domain without a dormancy block as gated', (t) => {
    const root = seedRepo(t);
    editDomain(root, 'eval-capability-tips.yaml', (value) => {
      delete value.dormancy;
      value.enabled = false;
    });
    assert.equal(entryOf(reconcile(root), 'eval:capability-tips').classification, 'gated');
  });

  it('allows a sparse active subset while all historical ranks stay unique and batch 1 stays memory', (t) => {
    const root = seedCertifiedHistory(t);
    const census = reconcile(root);
    assert.doesNotThrow(() => validateMeasurementBundleCensus(census, root));
    const ranked = census.entries
      .map((entry) => entry.validityMigration.riskRank)
      .filter((rank) => rank !== null)
      .sort((left, right) => left - right);
    assert.deepEqual(
      ranked,
      Array.from({ length: ranked.length }, (_, index) => index + 1),
    );

    const duplicate = structuredClone(census);
    entryOf(duplicate, 'eval:anchor-first').validityMigration.riskRank = entryOf(
      duplicate,
      'eval:a2a',
    ).validityMigration.riskRank;
    assert.throws(() => validateMeasurementBundleCensus(duplicate, root), /risk rank/i);

    // Batch numbers stay bound to risk ranks; home memory's batch-1 coordinate is
    // protected by the hard checker against its canonical evidence (see
    // scripts/check-measurement-bundles.test.mjs).
    const batchOffRank = structuredClone(census);
    entryOf(batchOffRank, 'eval:a2a').validityMigration.batch = 1;
    assert.throws(() => validateMeasurementBundleCensus(batchOffRank, root), /batch must match risk rank/);
  });

  it('lets a fresh public census on the dormant registry start its own migration and revive memory later', (t) => {
    const root = seedRepo(t, { withCensus: false });
    const census = reconcile(root);
    assert.equal(entryOf(census, 'eval:memory').classification, 'dormant');
    assert.equal(entryOf(census, 'eval:memory').validityMigration.riskRank, null);
    const first = census.entries.find((entry) => entry.validityMigration.riskRank === 1);
    assert.ok(first, 'a fresh public census ranks its active domains from 1');
    first.validityMigration.batch = 1;
    first.validityMigration.status = 'contract_ready';
    assert.doesNotThrow(() => validateMeasurementBundleCensus(census, root));
    writeFileSync(resolve(root, censusRef), stringify(census));

    editDomain(root, 'eval-memory.yaml', revive);
    const revived = reconcile(root);
    const memory = entryOf(revived, 'eval:memory');
    const maxRank = Math.max(...census.entries.map((entry) => entry.validityMigration.riskRank ?? 0));
    assert.equal(memory.classification, 'active_decision_bearing');
    assert.equal(memory.validityMigration.riskRank, maxRank + 1);
    assert.equal(entryOf(revived, first.domainId).validityMigration.batch, 1);
    assert.doesNotThrow(() => validateMeasurementBundleCensus(revived, root));
  });

  it('keeps target-owned evidence when a never-ranked dormant domain revives', (t) => {
    const root = seedRepo(t, { withCensus: false });
    const census = reconcile(root);
    const dormantMemory = entryOf(census, 'eval:memory').validityMigration;
    Object.assign(dormantMemory, {
      status: 'certified_insufficient',
      certificateRef: 'docs/harness-feedback/certificates/public-memory.yaml',
      resultRef: 'docs/harness-feedback/measurement-results/public-memory.yaml',
      replayRef: 'docs/harness-feedback/replays/public-memory.yaml',
    });
    assert.doesNotThrow(() => validateMeasurementBundleCensus(census, root));
    writeFileSync(resolve(root, censusRef), stringify(census));

    editDomain(root, 'eval-memory.yaml', revive);
    const memory = entryOf(reconcile(root), 'eval:memory').validityMigration;
    assert.notEqual(memory.riskRank, null);
    assert.equal(memory.status, 'certified_insufficient');
    assert.equal(memory.certificateRef, 'docs/harness-feedback/certificates/public-memory.yaml');
    assert.equal(memory.replayRef, 'docs/harness-feedback/replays/public-memory.yaml');
    assert.equal(memory.actionGate, 'keep_observe_only');
    assert.doesNotMatch(memory.hardBlockReason, /dormant/i);
    assert.match(memory.hardBlockReason, /F267 judgment/);
  });

  it('refreshes a stale dormancy hard block when a ranked domain revives', (t) => {
    const root = seedRepo(t);
    const census = reconcile(root);
    const anchor = entryOf(census, 'eval:anchor-first').validityMigration;
    anchor.hardBlockReason = 'Domain eval:anchor-first is dormant: stale lifecycle text';
    writeFileSync(resolve(root, censusRef), stringify(census));
    editDomain(root, 'eval-anchor-first.yaml', revive);
    const revived = entryOf(reconcile(root), 'eval:anchor-first').validityMigration;
    assert.equal(revived.actionGate, 'keep_observe_only');
    assert.equal(revived.riskRank, anchor.riskRank);
    assert.doesNotMatch(revived.hardBlockReason, /dormant/i);
  });

  it('builds a clean public census that sees dormancy without inheriting home evidence', (t) => {
    const root = seedRepo(t, { withCensus: false });
    editDomain(root, 'eval-memory.yaml', makeDormant);
    const census = reconcile(root);
    const memory = entryOf(census, 'eval:memory');
    assert.equal(memory.classification, 'dormant');
    assert.equal(memory.validityMigration.riskRank, null);
    assert.equal(memory.validityMigration.batch, null);
    assert.deepEqual(
      [memory.validityMigration.certificateRef, memory.validityMigration.resultRef, memory.validityMigration.replayRef],
      [null, null, null],
    );
    assert.equal(memory.validityMigration.actionGate, 'keep_observe_only');
    assert.doesNotMatch(readFileSync(resolve(root, censusRef), 'utf8'), /f267-[a-z0-9-]+\.(?:yaml|md)/i);
  });

  it('rejects a dormant entry that still carries a current action authorization', (t) => {
    const root = seedRepo(t);
    editDomain(root, 'eval-memory.yaml', makeDormant);
    const census = reconcile(root);
    const unsafe = structuredClone(census);
    const migration = entryOf(unsafe, 'eval:memory').validityMigration;
    migration.status = 'certified_usable';
    migration.actionGate = 'certificate_actions_allowed';
    migration.hardBlockReason = null;
    assert.throws(() => validateMeasurementBundleCensus(unsafe, root), /dormant/i);
    assert.throws(() => assertMeasurementVerdictActionAllowed(census, 'eval:memory', 'fix'), /keep_observe_only/);
  });

  it('revives a dormant domain without reopening its action gate', (t) => {
    const root = seedRepo(t);
    editDomain(root, 'eval-memory.yaml', makeDormant);
    const dormant = entryOf(reconcile(root), 'eval:memory');

    editDomain(root, 'eval-memory.yaml', revive);
    const revivedCensus = reconcile(root);
    const revived = entryOf(revivedCensus, 'eval:memory');
    assert.throws(
      () => assertMeasurementVerdictActionAllowed(revivedCensus, 'eval:memory', 'fix'),
      /keep_observe_only/,
    );
    assert.equal(revived.classification, 'active_decision_bearing');
    assert.deepEqual(revived.validityMigration, dormant.validityMigration);
    assert.equal(revived.validityMigration.actionGate, 'keep_observe_only');
  });
});
