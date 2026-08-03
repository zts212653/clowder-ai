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

describe('F267 real measurement bundle census', () => {
  it('covers each real registry entry once and derives the exact 9/1/1 classification', async () => {
    const { validateMeasurementBundleCensus } = await moduleUnderTest();
    const { scanMeasurementVerdictCorpus } = await corpusModuleUnderTest();
    const census = validateMeasurementBundleCensus(loadCensus(), repoRoot);
    const corpus = scanMeasurementVerdictCorpus(repoRoot);

    assert.equal(census.entries.length, 11);
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
        'eval:freshness',
        'eval:friction',
        'eval:memory',
        'eval:qc',
        'eval:sop',
        'eval:task-outcome',
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
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.deepEqual(
      active.filter((entry) => entry.validityMigration.batch === 1).map((entry) => entry.domainId),
      ['eval:memory'],
    );
    assert.equal(
      census.entries.find((entry) => entry.domainId === 'eval:task-outcome')?.validityMigration.status,
      'blocked_f275',
    );
    assert.equal(
      census.entries.find((entry) => entry.domainId === 'eval:friction')?.validityMigration.status,
      'certified_insufficient',
    );
    assert.equal(
      active.every((entry) => entry.validityMigration.actionGate === 'keep_observe_only'),
      true,
      'uncertified or insufficient bundles must fail closed',
    );
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
