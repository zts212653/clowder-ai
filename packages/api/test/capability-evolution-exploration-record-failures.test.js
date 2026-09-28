import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  ArchiveIntegrityError,
  controllerFingerprint,
  createArchiveReader,
  digestBytes,
  readFootballArchiveCatalog,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-exploration/archive-reader.js';
import { readFootballRecord } from '../dist/infrastructure/capability-evolution/adapters/microduck-exploration/observation.js';
import { createMicroduckExplorationBindings } from '../dist/infrastructure/capability-evolution/adapters/microduck-exploration/publication.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const root = resolve(repoRoot, 'docs/videos/f311-microduck-roadshow/pipeline/football');
const catalogPath = '/20260909-demo/catalog.json';
const comparisonPath = '/20260909-short-approach/comparison.json';
const input = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68' },
  objectRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'simulator:walking', version: '1' },
};
const rawCatalog = JSON.parse(await readFile(resolve(root, 'readiness/20260909-demo/catalog.json'), 'utf8'));
const original = await readFootballArchiveCatalog(createArchiveReader({ repoRoot }));

test('all archive publication integrity exits are invalid, while a failed read remains unavailable', async () => {
  for (const mode of [
    'syntax',
    'empty',
    'fingerprint',
    'inventory',
    'escape',
    'missing-group',
    'shared-run',
    'offline',
  ]) {
    const owner = createMicroduckExplorationBindings({
      repoRoot,
      readBytes: async (file) => {
        if (file.endsWith(catalogPath)) {
          if (mode === 'offline') throw new Error('store temporarily offline');
          if (mode === 'syntax') return Buffer.from('{bad json');
          if (mode === 'empty') return new Uint8Array();
          const value = structuredClone(rawCatalog);
          if (mode === 'fingerprint') value.versions[0].controllerFingerprintSha256 = '0'.repeat(64);
          if (mode === 'inventory') value.episodes.pop();
          if (mode === 'escape') value.episodes[0].captureRef.path = 'evidence/other-run/another.json.gz';
          if (mode === 'missing-group') value.runs[0].versionId = 'missing-version';
          return Buffer.from(JSON.stringify(value));
        }
        if (mode === 'shared-run' && file.endsWith(comparisonPath)) {
          const value = JSON.parse(await readFile(file, 'utf8'));
          const common = value.runs.find((run) =>
            rawCatalog.runs.some((entry) => entry.indexRef.path === run.indexRef.path),
          );
          assert(common, 'real data has an overlapping run');
          common.controllerFingerprintSha256 = '0'.repeat(64);
          return Buffer.from(JSON.stringify(value));
        }
        return readFile(file);
      },
    });
    const review = await owner.explorationReview(input);
    assert.equal(review.status, mode === 'offline' ? 'unavailable' : 'invalid', `${mode}: ${JSON.stringify(review)}`);
    assert.equal(
      review.blockers[0].code,
      mode === 'offline' ? 'owner_public_archive_unavailable' : 'owner_public_archive_invalid',
    );
  }
});

test('a corrupt exact capture yields invalid detail without destroying an independently readable comparison', async () => {
  const selected = original.runs.find((run) => run.id === '20260909-positions-v4');
  const comparison = original.runs.find((run) => run.id === '20260909-short-v8');
  assert(selected && comparison);
  for (const mode of ['offline', 'corrupt']) {
    const badPath = `/evidence/${selected.id}/${selected.index.episodes[0].capture}`;
    const owner = createMicroduckExplorationBindings({
      repoRoot,
      readBytes: async (file) => {
        if (file.endsWith(badPath)) {
          if (mode === 'offline') throw new Error('capture file offline');
          return Buffer.concat([await readFile(file), Buffer.from([1])]);
        }
        return readFile(file);
      },
    });
    const review = await owner.explorationReview({
      ...input,
      selectedNodeRef: selected.nodeRef,
      selectedExperimentRef: selected.experimentRef,
      comparisonExperimentRef: comparison.experimentRef,
    });
    assert.equal(review.status, 'resolved');
    const detail = review.details.find(
      (entry) => entry.experimentRef.ownerStateRef === selected.experimentRef.ownerStateRef,
    );
    assert.equal(detail.status, mode === 'offline' ? 'unavailable' : 'invalid');
    assert.equal('records' in detail, false, 'failed records cannot keep old observations');
    assert.equal(
      review.details.find((entry) => entry.experimentRef.ownerStateRef === comparison.experimentRef.ownerStateRef)
        .status,
      'resolved',
    );
  }
});

test('controller provenance and every capture semantic boundary use the integrity error family', async () => {
  const run = original.runs[0];
  const index = structuredClone(run.index);
  delete index.codeFiles['football/football_contract.py'];
  assert.throws(() => controllerFingerprint(index), ArchiveIntegrityError);
  const episode = run.index.episodes[0];
  const compressed = await readFile(resolve(root, `evidence/${run.id}/${episode.capture}`));
  const capture = JSON.parse(gunzipSync(compressed).toString('utf8'));
  for (const mode of ['compression', 'expanded-hash', 'case', 'samples', 'chronology']) {
    let bytes = compressed;
    const declaration = structuredClone(episode);
    if (mode === 'compression') bytes = Buffer.from('invalid gzip');
    if (mode === 'expanded-hash') declaration.uncompressedSha256 = '0'.repeat(64);
    if (['case', 'samples', 'chronology'].includes(mode)) {
      const altered = structuredClone(capture);
      if (mode === 'case') altered.case.ballXY[0] += 1;
      if (mode === 'samples') altered.samples.pop();
      if (mode === 'chronology') altered.samples[1].seconds = altered.samples[0].seconds;
      const expanded = Buffer.from(JSON.stringify(altered));
      declaration.uncompressedSha256 = digestBytes(expanded);
      bytes = gzipSync(expanded);
    }
    await assert.rejects(
      () => readFootballRecord({ verified: async () => bytes }, run, declaration),
      ArchiveIntegrityError,
      mode,
    );
  }
});
