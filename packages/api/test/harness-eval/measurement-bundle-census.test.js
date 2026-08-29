// @ts-check

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const censusPath = resolve(repoRoot, 'docs/harness-feedback/registry/measurement-bundles.yaml');

async function moduleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-bundle-census.js');
}

async function corpusModuleUnderTest() {
  return import('../../dist/infrastructure/harness-eval/measurement/measurement-bundle-census-corpus.js');
}

function loadCensus() {
  return parse(readFileSync(censusPath, 'utf8'));
}

function assertInstanceLocalMigrationContract(census, validateMeasurementBundleCensus) {
  const active = census.entries.filter((entry) => entry.classification === 'active_decision_bearing');
  const assigned = active.filter((entry) => entry.validityMigration.batch !== null);
  if (assigned.length === 0) {
    assert.equal(
      active.every(
        (entry) =>
          entry.validityMigration.status === 'unmigrated' &&
          entry.validityMigration.batch === null &&
          entry.validityMigration.certificateRef === null &&
          entry.validityMigration.resultRef === null &&
          entry.validityMigration.replayRef === null &&
          entry.validityMigration.actionGate === 'keep_observe_only' &&
          typeof entry.validityMigration.hardBlockReason === 'string' &&
          entry.validityMigration.hardBlockReason.length > 0,
      ),
      true,
      'a public bootstrap census must keep every active domain locked without inherited evidence',
    );

    const firstMigration = structuredClone(census);
    const memoryMigration = firstMigration.entries.find((entry) => entry.domainId === 'eval:memory').validityMigration;
    assert.equal(memoryMigration.riskRank, 1);
    memoryMigration.batch = 1;
    memoryMigration.status = 'contract_ready';
    assert.doesNotThrow(() => validateMeasurementBundleCensus(firstMigration, repoRoot));
  } else {
    assert.deepEqual(
      active.filter((entry) => entry.validityMigration.batch === 1).map((entry) => entry.domainId),
      ['eval:memory'],
    );
  }
}

describe('F267 real measurement bundle census', () => {
  it('covers each real registry entry once and derives the exact 11/1/1 classification', async () => {
    const { validateMeasurementBundleCensus } = await moduleUnderTest();
    const { scanMeasurementVerdictCorpus } = await corpusModuleUnderTest();
    const census = validateMeasurementBundleCensus(loadCensus(), repoRoot);
    const corpus = scanMeasurementVerdictCorpus(repoRoot);

    assert.equal(census.entries.length, 13);
    assert.equal(census.schemaVersion, 2);
    assert.deepEqual(
      census.entries
        .filter((entry) => entry.classification === 'active_decision_bearing')
        .map((entry) => entry.domainId)
        .sort(),
      [
        'eval:a2a',
        'eval:anchor-first',
        'eval:capability-wakeup',
        'eval:design-gate',
        'eval:freshness',
        'eval:friction',
        'eval:memory',
        'eval:qc',
        'eval:sop',
        'eval:task-outcome',
        'eval:trajectory-inspector',
      ],
    );
    assert.equal(census.entries.find((entry) => entry.domainId === 'eval:capability-tips')?.classification, 'gated');
    assert.equal(
      census.entries.find((entry) => entry.domainId === 'eval:external-case-closure')?.classification,
      'registered_nonoperational',
    );
    assert.equal(census.committedVerdictArtifactCount, corpus.total);
    assert.match(census.verdictCorpusHash, /^[a-f0-9]{64}$/);
    assert.equal(
      census.entries.find((entry) => entry.domainId === 'eval:capability-wakeup')?.committedVerdictArtifactCount,
      corpus.counts.get('eval:capability-wakeup') ?? 0,
    );
    const active = census.entries.filter((entry) => entry.classification === 'active_decision_bearing');
    assert.deepEqual(
      active.map((entry) => entry.validityMigration.riskRank).sort((left, right) => left - right),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
    assertInstanceLocalMigrationContract(census, validateMeasurementBundleCensus);
  });

  it('accepts a valid first instance-local migration without source snapshot statuses', async () => {
    const { validateMeasurementBundleCensus } = await moduleUnderTest();
    const partial = structuredClone(loadCensus());
    for (const entry of partial.entries.filter((candidate) => candidate.classification === 'active_decision_bearing')) {
      entry.validityMigration.batch = null;
      entry.validityMigration.status = 'unmigrated';
      entry.validityMigration.certificateRef = null;
      entry.validityMigration.resultRef = null;
      entry.validityMigration.replayRef = null;
      entry.validityMigration.actionGate = 'keep_observe_only';
      entry.validityMigration.hardBlockReason = 'Measurement validity has not been certified.';
    }
    const memoryMigration = partial.entries.find((entry) => entry.domainId === 'eval:memory').validityMigration;
    memoryMigration.batch = 1;
    memoryMigration.status = 'contract_ready';

    const validated = validateMeasurementBundleCensus(partial, repoRoot);
    assert.doesNotThrow(() => assertInstanceLocalMigrationContract(validated, validateMeasurementBundleCensus));

    const usable = structuredClone(partial);
    const usableMemory = usable.entries.find((entry) => entry.domainId === 'eval:memory').validityMigration;
    usableMemory.status = 'certified_usable';
    usableMemory.certificateRef = 'docs/harness-feedback/certificates/public-memory.yaml';
    usableMemory.resultRef = 'docs/harness-feedback/measurement-results/public-memory.yaml';
    usableMemory.replayRef = 'docs/harness-feedback/replays/public-memory.yaml';
    usableMemory.actionGate = 'certificate_actions_allowed';
    usableMemory.hardBlockReason = null;
    const validatedUsable = validateMeasurementBundleCensus(usable, repoRoot);
    assert.doesNotThrow(() => assertInstanceLocalMigrationContract(validatedUsable, validateMeasurementBundleCensus));
  });

  it('refreshes only derived verdict counts while preserving the reviewed census contract', async () => {
    const { refreshMeasurementBundleCensus } = await moduleUnderTest();
    const { scanMeasurementVerdictCorpus } = await corpusModuleUnderTest();
    const current = loadCensus();
    const corpus = scanMeasurementVerdictCorpus(repoRoot);
    const refreshed = refreshMeasurementBundleCensus(current, repoRoot, '2026-07-20T15:30:00.000Z');

    assert.equal(refreshed.generatedAt, '2026-07-20T15:30:00.000Z');
    assert.equal(refreshed.committedVerdictArtifactCount, corpus.total);
    assert.equal(refreshed.verdictCorpusHash, current.verdictCorpusHash);
    assert.equal(
      refreshed.entries.find((entry) => entry.domainId === 'eval:capability-wakeup')?.committedVerdictArtifactCount,
      corpus.counts.get('eval:capability-wakeup') ?? 0,
    );
    assert.equal(
      refreshed.entries.find((entry) => entry.domainId === 'eval:friction')?.classification,
      'active_decision_bearing',
    );
  });

  it('distinguishes same-size concurrent verdict corpora so their census hash line cannot auto-merge', async (t) => {
    const { scanMeasurementVerdictCorpus } = await corpusModuleUnderTest();
    const roots = ['left', 'right'].map((suffix) => mkdtempSync(join(tmpdir(), `f267-census-${suffix}-`)));
    t.after(() =>
      roots.forEach((root) => {
        rmSync(root, { force: true, recursive: true });
      }),
    );

    for (const root of roots) {
      const verdictDir = resolve(root, 'docs/harness-feedback/verdicts');
      mkdirSync(verdictDir, { recursive: true });
      writeFileSync(resolve(verdictDir, 'shared.md'), '---\ndomain_id: eval:a2a\n---\n');
    }
    writeFileSync(
      resolve(roots[0], 'docs/harness-feedback/verdicts/concurrent-left.md'),
      '---\ndomain_id: eval:a2a\n---\n',
    );
    writeFileSync(
      resolve(roots[1], 'docs/harness-feedback/verdicts/concurrent-right.md'),
      '---\ndomain_id: eval:a2a\n---\n',
    );

    const left = scanMeasurementVerdictCorpus(roots[0]);
    const right = scanMeasurementVerdictCorpus(roots[1]);
    assert.equal(left.total, right.total);
    assert.deepEqual([...left.counts], [...right.counts]);
    assert.notEqual(left.hash, right.hash);
  });

  it('accepts a fully unmigrated public instance only while every active domain remains fail-closed', async () => {
    const { validateMeasurementBundleCensus } = await moduleUnderTest();
    const publicBootstrap = loadCensus();
    const active = publicBootstrap.entries.filter((entry) => entry.classification === 'active_decision_bearing');
    for (const entry of active) {
      entry.validityMigration = {
        ...entry.validityMigration,
        batch: null,
        status: 'unmigrated',
        certificateRef: null,
        resultRef: null,
        replayRef: null,
        actionGate: 'keep_observe_only',
        hardBlockReason: `Public instance has not certified ${entry.domainId}.`,
      };
    }

    assert.doesNotThrow(() => validateMeasurementBundleCensus(publicBootstrap, repoRoot));

    const withoutBlock = structuredClone(publicBootstrap);
    withoutBlock.entries.find((entry) => entry.domainId === 'eval:a2a').validityMigration.hardBlockReason = null;
    assert.throws(() => validateMeasurementBundleCensus(withoutBlock, repoRoot), /hard block reason/i);

    const withPrivateEvidence = structuredClone(publicBootstrap);
    withPrivateEvidence.entries.find((entry) => entry.domainId === 'eval:a2a').validityMigration.certificateRef =
      'docs/harness-feedback/certificates/private.yaml';
    assert.throws(() => validateMeasurementBundleCensus(withPrivateEvidence, repoRoot), /cannot claim evidence refs/i);

    const withUnsafeAction = structuredClone(publicBootstrap);
    withUnsafeAction.entries.find((entry) => entry.domainId === 'eval:a2a').validityMigration.actionGate =
      'certificate_actions_allowed';
    assert.throws(() => validateMeasurementBundleCensus(withUnsafeAction, repoRoot), /action gate/i);
  });

  it('rejects stale coverage, duplicate ids, wrong consumers, and false active claims', async () => {
    const { validateMeasurementBundleCensus } = await moduleUnderTest();

    const stale = loadCensus();
    stale.entries.pop();
    assert.throws(() => validateMeasurementBundleCensus(stale, repoRoot), /registry coverage/i);

    const duplicate = loadCensus();
    duplicate.entries.push(structuredClone(duplicate.entries[0]));
    assert.throws(() => validateMeasurementBundleCensus(duplicate, repoRoot), /unique/i);

    const wrongConsumer = loadCensus();
    wrongConsumer.entries.find((entry) => entry.domainId === 'eval:friction').decisionConsumer.ownerCatId = 'wrong-cat';
    assert.throws(() => validateMeasurementBundleCensus(wrongConsumer, repoRoot), /consumer/i);

    const falseActive = loadCensus();
    falseActive.entries.find((entry) => entry.domainId === 'eval:external-case-closure').classification =
      'active_decision_bearing';
    assert.throws(() => validateMeasurementBundleCensus(falseActive, repoRoot), /classification/i);

    const duplicateRiskRank = loadCensus();
    duplicateRiskRank.entries.find((entry) => entry.domainId === 'eval:a2a').validityMigration.riskRank = 1;
    assert.throws(() => validateMeasurementBundleCensus(duplicateRiskRank, repoRoot), /risk rank/i);

    const skippedBatch = loadCensus();
    skippedBatch.entries.find((entry) => entry.domainId === 'eval:a2a').validityMigration.batch = 3;
    assert.throws(() => validateMeasurementBundleCensus(skippedBatch, repoRoot), /batch|risk rank/i);

    const unmigratedBatch = loadCensus();
    const unmigratedMemory = unmigratedBatch.entries.find(
      (entry) => entry.domainId === 'eval:memory',
    ).validityMigration;
    unmigratedMemory.batch = 1;
    unmigratedMemory.status = 'unmigrated';
    unmigratedMemory.certificateRef = null;
    unmigratedMemory.resultRef = null;
    unmigratedMemory.replayRef = null;
    unmigratedMemory.actionGate = 'keep_observe_only';
    unmigratedMemory.hardBlockReason = 'Measurement validity has not been certified.';
    assert.throws(() => validateMeasurementBundleCensus(unmigratedBatch, repoRoot), /unmigrated.*batch/i);

    const unsafeActionGate = loadCensus();
    const memoryMigration = unsafeActionGate.entries.find(
      (entry) => entry.domainId === 'eval:memory',
    ).validityMigration;
    memoryMigration.actionGate = 'certificate_actions_allowed';
    assert.throws(() => validateMeasurementBundleCensus(unsafeActionGate, repoRoot), /action gate|certified usable/i);

    const wrongCorpusHash = loadCensus();
    wrongCorpusHash.verdictCorpusHash = '0'.repeat(64);
    assert.throws(() => validateMeasurementBundleCensus(wrongCorpusHash, repoRoot), /corpus hash/i);
  });
});
